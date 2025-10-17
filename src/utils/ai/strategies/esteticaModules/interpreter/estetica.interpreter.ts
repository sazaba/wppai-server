/* ============================================================
   Estética – INTÉRPRETE (NLU → JSON canónico)
   - Convierte lenguaje natural a intents/slots cerrados
   - No toca DB; usa solo KB en memoria
   - Totalmente determinista + heurísticas ligeras
============================================================ */

export type DayPeriod = "morning" | "afternoon" | "evening";

export type BookingIntent =
    | "ASK_SLOTS"     // pedir horarios
    | "BOOK"         // reservar (fecha/hora concreta, o elegir de lista)
    | "CHOOSE"       // elegir una de las opciones ofrecidas (por índice)
    | "RESCHEDULE"   // reagendar
    | "CANCEL"       // cancelar
    | "INFO"         // info de servicio (precios, duración, preparación)
    | "GREET"        // saludo/pequeña charla
    | "UNSURE";      // baja confianza / faltan datos

export type NLUResult = {
    intent: BookingIntent;
    confidence: number;           // 0..1
    missing?: Array<"date" | "time" | "service" | "name" | "phone">;
    slots: {
        // normalizados
        date?: string | null;       // YYYY-MM-DD en TZ negocio
        time?: string | null;       // HH:mm (24h, TZ negocio)
        time_of_day?: DayPeriod | null;
        serviceId?: number | null;
        serviceName?: string | null;
        staffId?: number | null;
        location?: string | null;
        choice_index?: number | null; // 1 = primera (humano), 2= segunda...
        name?: string | null;
        phone?: string | null;
        notes?: string | null;
    };
    // Para trazabilidad
    debug?: {
        raw: string;
        signals: Record<string, unknown>;
    };
};

/* ====== KB mínima (no DB) ====== */
export type KBProcLite = {
    id: number;
    name: string;
    durationMin?: number | null;
    aliases?: string[] | null;
};

export type KBMinimalForInterpreter = {
    timezone: string;
    procedures: KBProcLite[];
};

/* ====== Utils de idioma/fecha ====== */
const DAY_WORDS: Record<string, number> = {
    domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5,
    sabado: 6, sábado: 6
};

const MONTHS: Record<string, number> = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

function normalizeNoDiacritics(s: string) {
    return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function parseDayPeriod(text: string): DayPeriod | null {
    const t = text.toLowerCase();
    if (/\b(mañana|manana|temprano|a primera hora)\b/.test(t)) return "morning";
    if (/\b(tarde|afternoon)\b/.test(t)) return "afternoon";
    if (/\b(noche|evening|tarde\s*noche)\b/.test(t)) return "evening";
    return null;
}

const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/;
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;     // 24h
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const ACCEPT_RE =
    /\b(ok(ay)?|perfecto|genial|listo|va|dale|sirve|me\s+sirve|me\s+va\s+bien|ag[eé]nd[ao]|reserv[ao]|confirmo|vamos\s+con|tomemos|ese|esa|sí|si)\b/i;
const CANCEL_RE = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i;
const RESCHED_RE = /\b(reagendar|mover|cambiar\s+la\s+cita|otra\s+hora|otro\s+d[ií]a)\b/i;
const GREET_RE = /\b(hola|buen[oa]s|qué\s+tal|que\s+tal|saludos)\b/i;
const PRICE_RE = /\b(precio|vale|cu[áa]nto\s+cuesta|costo|tarifa)\b/i;
const INFO_RE = /\b(duraci[oó]n|preparaci[oó]n|contraindicaci[oó]n|cuidado|post\s*cuidado|indicaciones)\b/i;

const ORDINAL_RE = /\b(primera|1(?:ra|era)?|segunda|2(?:da)?|tercera|3(?:ra)?)\b/i;
function ordinalIndex(text: string): number | null {
    const m = ORDINAL_RE.exec(text);
    if (!m) return null;
    const w = m[1].toLowerCase();
    if (w.startsWith("primera") || w.startsWith("1")) return 1;
    if (w.startsWith("segunda") || w.startsWith("2")) return 2;
    if (w.startsWith("tercera") || w.startsWith("3")) return 3;
    return null;
}

function properCase(v?: string) {
    return (v || "")
        .trim()
        .replace(/\s+/g, " ")
        // @ts-ignore Unicode property escapes
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function normalizePhone(raw?: string | null): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D+/g, "");
    if (!digits) return null;
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

function pad2(n: number) { return n.toString().padStart(2, "0"); }

/* ====== Interpretadores de fecha relativa (en TZ negocio) ======
   Nota: aquí NO convertimos TZ realmente (dejamos YYYY-MM-DD).
   La lógica de TZ/UTC la maneja estetica.schedule.
================================================================= */
type NaturalWhen =
    | { kind: "nearest"; period: DayPeriod | null }
    | { kind: "weekday"; weekday: number; which: "this_or_next" | "next_week"; period: DayPeriod | null }
    | { kind: "date"; localDateISO: string; period: DayPeriod | null };

function dayjsLike(now: Date, addDaysN: number) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + addDaysN);
    return d;
}

function toLocalISODate(d: Date) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function interpretNaturalWhen(text: string, now: Date): NaturalWhen | null {
    const t = text.trim().toLowerCase();

    // próxima semana
    const nextWeekWd = new RegExp(
        `(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo).{0,30}(pr[oó]xima\\s+semana|semana\\s+que\\s+viene|otra\\s+semana)`,
        "i"
    ).exec(t);
    if (nextWeekWd) {
        const wd = DAY_WORDS[normalizeNoDiacritics(nextWeekWd[1]).toLowerCase()];
        return { kind: "weekday", weekday: wd, which: "next_week", period: parseDayPeriod(t) };
    }

    // "miércoles", "este miércoles", "próximo miércoles"
    const wdWord = Object.keys(DAY_WORDS).find((w) => new RegExp(`\\b${w}\\b`, "i").test(t));
    if (wdWord) {
        const wd = DAY_WORDS[wdWord];
        const saysNext = /\bpr[oó]ximo\b/.test(t);
        return { kind: "weekday", weekday: wd, which: saysNext ? "next_week" : "this_or_next", period: parseDayPeriod(t) };
    }

    // “la más próxima / próxima disponible”
    if (/\b(la\s+m[aá]s\s+pr[oó]xima|m[aá]s\s+cercana|inmediata|lo\s+m[aá]s\s+pronto|pr[oó]xima\s+disponible)\b/.test(t)) {
        return { kind: "nearest", period: parseDayPeriod(t) };
    }

    // "mañana" / "pasado mañana" / "hoy"
    if (/\bpasado\s*ma[ñn]ana\b/.test(t)) {
        const d = dayjsLike(now, 2);
        return { kind: "date", localDateISO: toLocalISODate(d), period: parseDayPeriod(t) };
    }
    if (/\bma[ñn]ana\b/.test(t)) {
        const d = dayjsLike(now, 1);
        return { kind: "date", localDateISO: toLocalISODate(d), period: parseDayPeriod(t) };
    }
    if (/\bhoy\b/.test(t)) {
        const d = dayjsLike(now, 0);
        return { kind: "date", localDateISO: toLocalISODate(d), period: parseDayPeriod(t) };
    }

    // "15/10" o "15-10" o "15 de octubre"
    const dm =
        /(\b\d{1,2})\s*(?:\/|\-|de\s+)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|\d{1,2})/i.exec(
            t
        );
    if (dm) {
        const day = parseInt(dm[1], 10);
        const monthToken = dm[2].toLowerCase();
        const year = now.getFullYear();
        const month = /\d{1,2}/.test(monthToken) ? Math.max(0, Math.min(11, parseInt(monthToken, 10) - 1)) : MONTHS[monthToken];
        let candidate = new Date(year, month, day);
        // si ya pasó, asume el próximo año
        if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
            candidate = new Date(year + 1, month, day);
        }
        return { kind: "date", localDateISO: toLocalISODate(candidate), period: parseDayPeriod(t) };
    }

    // "jueves 15", "miércoles 3 de noviembre"
    const wdDm =
        /(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))?/i.exec(
            t
        );
    if (wdDm) {
        const wd = DAY_WORDS[normalizeNoDiacritics(wdDm[1]).toLowerCase()];
        const day = parseInt(wdDm[2], 10);
        const month = wdDm[3] ? MONTHS[wdDm[3].toLowerCase()] : now.getMonth();
        const year = now.getFullYear();
        let cand = new Date(year, month, day);
        if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
            cand = new Date(year, month + 1, day);
        }
        return { kind: "date", localDateISO: toLocalISODate(cand), period: parseDayPeriod(t) };
    }

    return null;
}

/* ====== Extracción de hora (minutos locales) → HH:mm ====== */
function extractHHmm(text: string): string | null {
    const m12 = AMPM_RE.exec(text);
    if (m12) {
        let h = parseInt(m12[1], 10);
        const minutes = m12[2] ? parseInt(m12[2], 10) : 0;
        const ampm = m12[3].toLowerCase();
        if (h === 12) h = 0;
        if (ampm === "pm") h += 12;
        return `${pad2(h)}:${pad2(minutes)}`;
    }
    const m24 = HHMM_RE.exec(text);
    if (m24) {
        const h = parseInt(m24[1], 10);
        const minutes = parseInt(m24[2], 10);
        return `${pad2(h)}:${pad2(minutes)}`;
    }
    return null;
}

/* ====== Match de servicio por nombre/alias ====== */
function matchService(text: string, procs: KBProcLite[]): { id: number; name: string } | null {
    const t = normalizeNoDiacritics(text.toLowerCase());
    let best: { id: number; name: string; score: number } | null = null;

    for (const p of procs) {
        const names: string[] = [p.name, ...(p.aliases || [])].filter(Boolean) as string[];
        for (const label of names) {
            const labelN = normalizeNoDiacritics(label.toLowerCase());
            if (!labelN) continue;
            if (t.includes(labelN)) {
                const sc = labelN.length; // heurística sencilla
                if (!best || sc > best.score) {
                    best = { id: p.id, name: p.name, score: sc };
                }
            }
        }
    }
    return best ? { id: best.id, name: best.name } : null;
}

/* ====== INTÉRPRETE PRINCIPAL ====== */
export function interpretUserMessage(
    text: string,
    kb: KBMinimalForInterpreter,
    now: Date = new Date()
): NLUResult {
    const raw = text || "";
    const t = raw.trim();
    const tLower = t.toLowerCase();

    // señales base
    const greet = GREET_RE.test(tLower);
    const wantsCancel = CANCEL_RE.test(tLower);
    const wantsResched = RESCHED_RE.test(tLower);
    const wantsPrice = PRICE_RE.test(tLower);
    const wantsInfo = INFO_RE.test(tLower);
    const accepted = ACCEPT_RE.test(tLower);
    const ord = ordinalIndex(tLower);

    // nombre / teléfono
    const nameMatch = NAME_RE.exec(t);
    const name = nameMatch ? properCase(nameMatch[2]) : null;
    const phone = normalizePhone(PHONE_ANY_RE.exec(t)?.[2] || null);

    // servicio
    const svc = matchService(tLower, kb.procedures);

    // fecha y franja
    const when = interpretNaturalWhen(tLower, now);
    const time_of_day = parseDayPeriod(tLower);
    const time = extractHHmm(tLower);

    // Intención bruta
    let intent: BookingIntent = "UNSURE";
    let confidence = 0.5;

    if (wantsCancel) { intent = "CANCEL"; confidence = 0.9; }
    else if (wantsResched) { intent = "RESCHEDULE"; confidence = 0.85; }
    else if (ord) { intent = "CHOOSE"; confidence = 0.85; }
    else if (accepted && (time || when)) { intent = "BOOK"; confidence = 0.8; }
    else if (time || when || time_of_day) { intent = "ASK_SLOTS"; confidence = 0.75; }
    else if (wantsPrice || wantsInfo) { intent = "INFO"; confidence = 0.7; }
    else if (greet) { intent = "GREET"; confidence = 0.6; }

    // Slots normalizados
    const slots: NLUResult["slots"] = {
        date: when?.kind === "date" ? when.localDateISO : null,
        time: time ?? null,
        time_of_day: (when?.kind === "nearest" ? when.period : (when?.kind === "weekday" ? when.period : time_of_day)) ?? null,
        serviceId: svc?.id ?? null,
        serviceName: svc?.name ?? null,
        choice_index: ord ?? null,
        name,
        phone,
        notes: null,
        staffId: null,
        location: null,
    };

    // Reglas: si dice “Sí, jueves 2:00 pm, Santiago, 310...” → BOOK directo
    if (intent === "ASK_SLOTS" && (name || phone) && (time || when)) {
        intent = "BOOK";
        confidence = Math.max(confidence, 0.82);
    }

    // Faltantes según intent
    const missing: NLUResult["missing"] = [];
    if (intent === "BOOK") {
        if (!slots.date && !when) missing.push("date");
        // si menciona franja pero no hora, dejamos que schedule ofrezca, no lo marcamos como missing "time"
        if (!slots.time && !slots.time_of_day) missing.push("time");
        if (!slots.serviceId && !slots.serviceName) missing.push("service"); // opcional si tu flujo permite sin servicio
        if (!slots.name) missing.push("name");
        if (!slots.phone) missing.push("phone");
    } else if (intent === "ASK_SLOTS") {
        if (!slots.date && !when) missing.push("date"); // al menos fecha/fanja
    } else if (intent === "CHOOSE") {
        if (!slots.choice_index) missing.push("time"); // equivalente a elegir hora
    }

    // si faltan muchas cosas, baja la confianza e ir a UNSURE
    if (missing.length >= 3 && intent !== "GREET" && intent !== "INFO") {
        intent = "UNSURE";
        confidence = 0.45;
    }

    return {
        intent,
        confidence,
        missing: missing.length ? missing : undefined,
        slots,
        debug: {
            raw,
            signals: {
                greet, wantsCancel, wantsResched, wantsPrice, wantsInfo, accepted, ord,
                name, phone, svc, when, time_of_day, time
            }
        }
    };
}

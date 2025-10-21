/* ============================================================
   Estética – INTÉRPRETE (NLU → JSON canónico)
   - Convierte lenguaje natural a intents/slots cerrados
   - No toca DB; usa solo KB en memoria
   - Totalmente determinista + heurísticas ligeras
============================================================ */
// ⬇️ Agrega esto al inicio del archivo (o junto a otras imports)
import { utcToZonedTime, zonedTimeToUtc, format as tzFormat } from "date-fns-tz";

export type DayPeriod = "morning" | "afternoon" | "evening";

export type BookingIntent =
    | "ASK_SLOTS"     // pedir horarios
    | "BOOK"          // reservar (fecha/hora concreta, o elegir de lista)
    | "CHOOSE"        // elegir una de las opciones ofrecidas (por índice)
    | "RESCHEDULE"    // reagendar
    | "CANCEL"        // cancelar
    | "INFO"          // info de servicio (precios, duración, preparación)
    | "GREET"         // saludo/pequeña charla
    | "UNSURE";       // baja confianza / faltan datos

export type NLUResult = {
    intent: BookingIntent;
    confidence: number;           // 0..1
    missing?: Array<"date" | "time" | "service" | "name" | "phone">;
    slots: {
        date?: string | null;         // YYYY-MM-DD en TZ negocio
        time?: string | null;         // HH:mm (24h, TZ negocio)
        time_of_day?: DayPeriod | null;
        serviceId?: number | null;
        serviceName?: string | null;
        staffId?: number | null;
        location?: string | null;
        choice_index?: number | null; // 1 = primera, 2 = segunda...
        name?: string | null;
        phone?: string | null;
        notes?: string | null;
    };
    debug?: { raw: string; signals: Record<string, unknown> };
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

/* ===== Helpers de fecha con TZ del negocio ===== */
function todayInTZ(tz: string, now: Date = new Date()): Date {
    const z = utcToZonedTime(now, tz);
    // normalizamos a medianoche local
    return new Date(z.getFullYear(), z.getMonth(), z.getDate());
}

function addDaysTZ(baseLocal: Date, days: number, tz: string): Date {
    // baseLocal se asume ya “local” (YYYY-MM-DD local)
    const d = new Date(baseLocal.getFullYear(), baseLocal.getMonth(), baseLocal.getDate());
    d.setDate(d.getDate() + days);
    return d;
}

function toLocalISODateTZ(dLocal: Date): string {
    const y = dLocal.getFullYear();
    const m = String(dLocal.getMonth() + 1).padStart(2, "0");
    const d = String(dLocal.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}


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

/* ---------- Nombres y teléfonos (mejorados, no intrusivos) ---------- */
// Explícito: “mi nombre es…”, “nombre: …”, “soy …”, “me llamo …”
// Corta antes de ",", ".", "y mi teléfono", "teléfono", "cel", o un número
const NAME_RE =
    /(mi\s*nombre\s*(?:es|:)?|^nombre\s*:|^soy\b|^yo\s*soy\b|me\s*llamo)\s+([a-záéíóúñü\s]{2,80}?)(?=\s*(?:,|\.|$|y\s+mi\s+tel[eé]fono|tel[eé]fono|cel(?:ular)?|contacto|\(?\+?\d|\d{7,}))/i;

function cleanCapturedName(raw?: string | null): string | null {
    if (!raw) return null;
    let v = raw
        .replace(/\s+y\s+mi\s+tel[eé]fono.*$/i, "")
        .replace(/\s+(tel[eé]fono|cel(?:ular)?|contacto)\b.*$/i, "")
        .replace(/[,\.\-–—]+$/g, "")
        .trim()
        .replace(/\s+/g, " ");
    if (!v || /^mi\s*nombre\s*es$/i.test(v)) return null;
    return properCase(v);
}


// Fallback: mensaje que parece SOLO un nombre (sin números/horas/keywords) – “Santiago z”
const NAME_ONLY_RE = /^[a-záéíóúñü\s]{2,80}$/i;

// Teléfono en cualquier formato; tomamos el candidato con más dígitos.
const PHONE_ANY_RE = /[\+\(]?\d[\d\)\-\s\.]{6,}/g;

const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;     // 24h
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

const ACCEPT_RE =
    /\b(quiero|tomo|me\s*(quedo|sirve|va\s*bien)|voy\s*con|vamos\s*con|la\s*de|esa\s*de|ok(ay)?|perfecto|genial|listo|va|dale|ag[eé]nd[ao]|reserv[ao]|confirmo|sí|si)\b/i;

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
    if (digits.length >= 12) return digits.slice(-12);
    if (digits.length >= 10) return digits.slice(-10);
    return digits.length >= 7 ? digits : null;
}

function pad2(n: number) { return n.toString().padStart(2, "0"); }

/* ====== Interpretadores de fecha relativa (en TZ negocio) ====== */
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

// Acepta TZ del negocio y año explícito cuando el usuario lo provee
// Acepta TZ del negocio y año explícito cuando el usuario lo provee
function interpretNaturalWhen(text: string, now: Date, tz: string): NaturalWhen | null {
    const t = text.trim().toLowerCase();
    const today = todayInTZ(tz, now);

    // "jueves de la próxima semana / semana que viene / la otra semana"
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

    // "hoy / mañana / pasado mañana"
    if (/\bhoy\b/.test(t)) {
        return { kind: "date", localDateISO: toLocalISODateTZ(today), period: parseDayPeriod(t) };
    }
    if (/\bma[ñn]ana\b/.test(t)) {
        return { kind: "date", localDateISO: toLocalISODateTZ(addDaysTZ(today, 1, tz)), period: parseDayPeriod(t) };
    }
    if (/\bpasado\s*ma[ñn]ana\b/.test(t)) {
        return { kind: "date", localDateISO: toLocalISODateTZ(addDaysTZ(today, 2, tz)), period: parseDayPeriod(t) };
    }

    // Fechas explícitas: "15/10", "15-10", "15 de octubre", "15 de octubre de 2025", "15/10/2026"
    const dm =
        /(\b\d{1,2})\s*(?:\/|\-|de\s+)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|\d{1,2})(?:\s*(?:de)?\s*(\d{4}))?/i.exec(t);
    if (dm) {
        const day = parseInt(dm[1], 10);
        const monthToken = dm[2].toLowerCase();
        const explicitYear = dm[3] ? parseInt(dm[3], 10) : null;

        const year = explicitYear ?? today.getFullYear();
        const month = /\d{1,2}/.test(monthToken)
            ? Math.max(0, Math.min(11, parseInt(monthToken, 10) - 1))
            : MONTHS[monthToken];

        let candidate = new Date(year, month, day);
        const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Si no hay año explícito y la fecha ya pasó, empuja al año siguiente
        if (!explicitYear && candidate < todayMid) {
            candidate = new Date(year + 1, month, day);
        }

        return { kind: "date", localDateISO: toLocalISODateTZ(candidate), period: parseDayPeriod(t) };
    }

    // Día de semana + día del mes: "jueves 15", "miércoles 3 de noviembre", opcional año
    const wdDm =
        /(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))?(?:\s*(?:de)?\s*(\d{4}))?/i.exec(t);
    if (wdDm) {
        const wd = DAY_WORDS[normalizeNoDiacritics(wdDm[1]).toLowerCase()];
        const day = parseInt(wdDm[2], 10);
        const month = wdDm[3] ? MONTHS[wdDm[3].toLowerCase()] : today.getMonth();
        const explicitYear = wdDm[4] ? parseInt(wdDm[4], 10) : null;
        const year = explicitYear ?? today.getFullYear();

        let cand = new Date(year, month, day);
        const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Si no hay año explícito y quedó en el pasado, empujar un mes
        if (!explicitYear && cand < todayMid) {
            cand = new Date(year, month + 1, day);
        }

        return { kind: "date", localDateISO: toLocalISODateTZ(cand), period: parseDayPeriod(t) };
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

    // servicio
    const svc = matchService(tLower, kb.procedures);

    // fecha y franja
    const when = interpretNaturalWhen(tLower, now, kb.timezone);
    const time_of_day = parseDayPeriod(tLower);
    const time = extractHHmm(tLower);

    // --------- Nombre / Teléfono mejorados ----------
    // 1) explícitos
    const nameFromExp = (() => {
        const m = NAME_RE.exec(t);
        return m ? cleanCapturedName(m[2]) : null;
    })();


    // 2) “solo nombre” (sin números/horas/días/meses)
    const looksLikeOnlyName =
        !/\d/.test(t) && !HHMM_RE.test(tLower) && !AMPM_RE.test(tLower) &&
        !Object.keys(DAY_WORDS).some(w => new RegExp(`\\b${w}\\b`, "i").test(tLower)) &&
        !Object.keys(MONTHS).some(m => new RegExp(`\\b${m}\\b`, "i").test(tLower)) &&
        NAME_ONLY_RE.test(t);

    const name = nameFromExp || (looksLikeOnlyName ? properCase(t) : null);

    // 3) teléfono: elegir el candidato con más dígitos
    let phone: string | null = null;
    const phoneMatches = t.match(PHONE_ANY_RE);
    if (phoneMatches && phoneMatches.length) {
        const best = phoneMatches
            .map(s => s.replace(/\D+/g, ""))
            .sort((a, b) => b.length - a.length)[0];
        phone = normalizePhone(best);
    }

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

    // “Sí, jueves 2:00 pm, Santiago, 310...” → BOOK directo
    if (intent === "ASK_SLOTS" && (name || phone) && (time || when)) {
        intent = "BOOK";
        confidence = Math.max(confidence, 0.82);
    }

    // Faltantes según intent
    const missing: NLUResult["missing"] = [];
    if (intent === "BOOK") {
        if (!slots.date && !when) missing.push("date");
        if (!slots.time && !slots.time_of_day) missing.push("time");
        if (!slots.serviceId && !slots.serviceName) missing.push("service");
        if (!slots.name) missing.push("name");
        if (!slots.phone) missing.push("phone");
    } else if (intent === "ASK_SLOTS") {
        // Si hay solo franja (morning/afternoon/evening), dejamos que schedule proponga sin exigir fecha
        if (!slots.date && !when && !slots.time_of_day) missing.push("date");

    } else if (intent === "CHOOSE") {
        if (!slots.choice_index) missing.push("time");
    }

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
            signals: { greet, wantsCancel, wantsResched, wantsPrice, wantsInfo, accepted, ord, name, phone, svc, when, time_of_day, time }
        }
    };
}

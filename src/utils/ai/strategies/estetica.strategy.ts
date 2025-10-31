// utils/ai/strategies/estetica.strategy.ts
import axios from "axios";
import prisma from "../../../lib/prisma";
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
} from "@prisma/client";
import { openai } from "../../../lib/openai";
import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";
import {
    loadEsteticaKB,
    resolveServiceName,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

/* ==== CONFIG ==== */
const CONF = {
    MEM_TTL_MIN: 60,
    GRAN_MIN: 15,
    MAX_HISTORY: 20,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.3,
    MODEL: process.env.IA_TEXT_MODEL || "gpt-4o-mini",
};

const IMAGE_WAIT_MS = 1000;
const IMAGE_CARRY_MS = 60_000;
const IMAGE_LOOKBACK_MS = 300_000;
const REPLY_DEDUP_WINDOW_MS = 120_000;

/* ===== UTILS ===== */


function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
const processedInbound = new Map<number, number>();
function seenInboundRecently(mid: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(mid);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(mid, now);
    return false;
}

/** Conversational dedup (double-reply window per conversation) */
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = 120_000) {
    const now = Date.now();
    const prev = recentReplies.get(conversationId);
    if (prev && prev.afterMs >= clientTs.getTime() && now - prev.repliedAtMs <= windowMs) return true;
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
    return false;
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: Date.now() });
}

// Convierte "HH:MM" a minutos desde medianoche (ej.: "13:30" -> 810)
function hmToMin(hm?: string | null): number | null {
    if (!hm) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (isNaN(h) || isNaN(mi)) return null;
    return h * 60 + mi;
}

// Convierte minutos a etiqueta 12h (ej.: 780 -> "1pm")
function minToLabel(min: number) {
    const h24 = Math.floor(min / 60);
    const m = min % 60;
    const ampm = h24 >= 12 ? "pm" : "am";
    const h12 = ((h24 % 12) || 12);
    return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
}

// Orden y etiqueta de días para day = 'mon'|'tue'|... según tu tabla
const DAY_ORDER: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const DAY_LABEL: Record<string, string> = { mon: "L", tue: "M", wed: "X", thu: "J", fri: "V", sat: "S", sun: "D" };


/** Detecta si el mensaje es nota de voz o audio */
function isVoiceInbound(last: { isVoiceNote?: boolean | null; mediaType?: any; mimeType?: string | null; }) {
    if (last?.isVoiceNote) return true;
    const mt = String(last?.mediaType ?? "").toLowerCase();
    if (mt === "audio" || mt === "voice") return true;
    return (last?.mimeType || "").startsWith("audio/");
}

/** Busca imagen contextual */
async function pickImageForContext({
    conversationId,
    userText,
    caption,
    referenceTs,
}: {
    conversationId: number;
    userText: string;
    caption: string;
    referenceTs: Date;
}) {
    const s = userText.toLowerCase();
    const mentionsImg =
        /\b(foto|imagen|selfie|captura)\b/.test(s) ||
        /(mira|env[ií]e)\s+(la\s+)?(foto|imagen)/.test(s);

    const recent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: {
                gte: new Date(referenceTs.getTime() - (mentionsImg ? IMAGE_LOOKBACK_MS : IMAGE_CARRY_MS)),
                lte: referenceTs,
            },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });

    if (recent?.mediaUrl) {
        const note = recent.caption ? `\n\nNota de la imagen: ${recent.caption}` : "";
        return { url: recent.mediaUrl, noteToAppend: note };
    }
    return { url: null, noteToAppend: "" };
}

/* ======= STATE (conversation_state) ======= */
type AgentState = {
    greeted?: boolean;
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    draft?: {
        name?: string;
        phone?: string;
        procedureId?: number;
        procedureName?: string;
        whenISO?: string;
        whenText?: string; // fecha/hora “tal cual” que escribió el cliente (sin calcular)
        // NOTA: no usamos timeHHMM ni timeNote para no “inferir” horas
    };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
    handoffLocked?: boolean;
};
function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}
async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({
        where: { conversationId },
        select: { data: true },
    });
    const raw = (row?.data as any) || {};
    const data: AgentState = {
        greeted: !!raw.greeted,
        lastIntent: raw.lastIntent,
        lastServiceId: raw.lastServiceId ?? null,
        lastServiceName: raw.lastServiceName ?? null,
        draft: raw.draft ?? {},
        summary: raw.summary ?? undefined,
        expireAt: raw.expireAt,
        handoffLocked: !!raw.handoffLocked,
    };
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { greeted: data.greeted, handoffLocked: data.handoffLocked, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    return data;
}
async function saveState(conversationId: number, data: AgentState) {
    const next: AgentState = { ...data, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    await prisma.conversationState.upsert({
        where: { conversationId },
        create: { conversationId, data: next as any },
        update: { data: next as any },
    });
}
async function patchState(conversationId: number, patch: Partial<AgentState>) {
    const prev = await loadState(conversationId);
    await saveState(conversationId, { ...prev, ...patch });
}

/* ===== INTENT DETECTOR (no forzar agenda) ===== */

/* ==== INFO / SCHEDULE GUARDS (del componente viejo) ==== */
function isSchedulingCue(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(agendar|agenda|reservar|programar)\b/.test(s) ||
        /quieres ver horarios|te paso horarios|dime el dia y hora|que dia y hora prefieres/.test(s)
    );
}

function isShortQuestion(t: string): boolean {
    const s = (t || "").trim();
    const noSpaces = s.replace(/\s+/g, "");
    const hasQM = /[?¿]/.test(s);
    return hasQM && s.length <= 120 && noSpaces.length >= 2;
}

function containsDateOrTimeHints(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(hoy|manana|mañana|proxima|semana|lunes|martes|miercoles|jueves|viernes|sabado|sábado|domingo|am|pm|a las|hora|tarde|noche|mediodia|medio dia)\b/.test(s) ||
        /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(s) ||
        /\b(\d{1,2}:\d{2})\b/.test(s)
    );
}

function isPaymentQuestion(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return /\b(pagos?|metodos? de pago|tarjeta|efectivo|transferencia|nequi|daviplata|pse)\b/.test(s);
}

function isGeneralInfoQuestion(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(que es|de que se trata|como funciona|beneficios?|riesgos?|efectos secundarios?|contraindicaciones?|cuidados|cuanto dura|duracion|quien lo hace|profesional|doctor(a)?)\b/.test(s) ||
        /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|sede|como llego|parqueadero)\b/.test(s) ||
        isPaymentQuestion(t)
    );
}
/** Verbos/expresiones de intención de reservar (no hardcode de negocio; solo intención lingüística) */
function hasBookingIntent(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return /\b(agendar?|agendo|agendemos|programar?|reserv(ar|a|ame)|reserva|quiero ir|puedo ir|agendalo|agendame|agenda(?:me)?)\b/.test(s);
}

/** Ancla temporal explícita (fecha/slot concreto) */
function hasConcreteTimeAnchor(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return /\b(\d{1,2}([:.]\d{2})?\s*(am|pm)?)\b/.test(s) || /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(s);
}



function isEducationalQuestion(text: string): boolean {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (/\b(que es|de que se trata|como funciona|como actua|beneficios?|riesgos?|efectos secundarios?|cuidados|contraindicaciones?)\b/.test(t)) return true;
    if (/\b(b[óo]tox|toxina|acido hialuronico|peeling|manchas|acne|rosacea|melasma|flacidez)\b/.test(t)) return true;
    if (/\b(recomendable|sirve|me ayuda)\b/.test(t) && /\b(rosacea|acne|melasma|cicatriz|flacidez|arrugas|manchas)\b/.test(t)) return true;
    return false;
}

function shouldBypassScheduling(t: string): boolean {
    if (isSchedulingCue(t) || containsDateOrTimeHints(t)) return false; // señales claras → sí agenda
    if (isShortQuestion(t) || isGeneralInfoQuestion(t) || isEducationalQuestion(t)) return true; // informativo → NO agenda
    return false;
}


type Intent = "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";

function detectIntent(text: string, draft: AgentState["draft"]): Intent {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

    // señales de agenda explícita
    const scheduleHints = [
        "agendar", "agendo", "agendemos", "agenda", "cita", "programar", "reservar", "reserva",
        "disponible", "disponibilidad", "horario", "hora", "dia", "fecha", "cuando atienden", "para el",
        "quiero ir", "puedo ir", "mañana", "manana", "tarde", "noche", "am", "pm", "a las"
    ];
    if (scheduleHints.some(h => t.includes(h))) return "schedule";


    // Si ya trajo alguna pieza REAL de agenda (servicio o fecha/hora), seguimos en schedule
    if (draft?.procedureId || draft?.procedureName || draft?.whenText || draft?.whenISO) return "schedule";


    // precio/costo
    if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";

    // reprogramación / cancelación
    if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";

    // preguntas tipo “¿qué es?”, “¿cómo funciona?”
    if (/\b(que es|como funciona|efectos|riesgos|duracion|contraindicaciones|recomendaciones)\b/.test(t)) return "info";

    // saludo/otros → libre
    return "other";
}

async function detectIntentSmart(text: string, draft: AgentState["draft"]): Promise<Intent> {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

    // Price / cambios / cancelación
    if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";
    if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";

    // IA semántica
    const cls = await classifyTurnLLM(text);

    // Consulta pura de horarios → info
    if (cls.label === "ask_hours") return "info";


    // Doble señal para activar agenda
    const wantBook = hasBookingIntent(t) || cls.label === "book";
    const draftHasPieces = !!(draft?.procedureId || draft?.procedureName || draft?.whenText || draft?.whenISO);
    const hasTime = hasConcreteTimeAnchor(t) || draftHasPieces;

    if (wantBook && hasTime) return "schedule";

    // Si hay “hora/día/fecha” pero sin intención explícita → info (evita falsos positivos)
    if (/\b(hora|horario|dia|fecha|am|pm)\b/.test(t) && !wantBook) return "info";

    // Info general/educativa
    if (/\b(que es|como funciona|efectos|riesgos|duracion|contraindicaciones|recomendaciones|ubicacion|direccion|donde|mapa|sede|parqueadero)\b/.test(t)) {
        return "info";
    }

    return "other";
}


/* ===== Summary extendido con cache en conversation_state ===== */
function softTrim(s: string | null | undefined, max = 240) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function summaryPickLine(summary: string, startsWith: string): string | null {
    const line = summary.split(/\r?\n/).find(l => l.trim().startsWith(startsWith));
    return line ? line.trim() : null;
}



function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}


/** Lista bonita de servicios con emojis y saltos de línea */
function formatServicesPretty(kb: EsteticaKB, max = 8): string {
    const items = (kb.procedures ?? [])
        .filter(p => p?.enabled !== false)
        .slice(0, max)
        .map(p => {
            const desde = p?.priceMin ? ` — *desde* ${formatCOP(p.priceMin)}` : "";
            return `• ✨ ${p.name}${desde}`;
        });
    return items.length ? items.join("\n") : "• ✨ (Aún no hay servicios configurados)";
}






function paymentMethodsFromKB(kb: EsteticaKB): string[] {
    const list: string[] = [];
    const pm: any = (kb as any).paymentMethods ?? (kb as any).payments ?? [];
    if (Array.isArray(pm)) {
        for (const it of pm) {
            if (!it) continue;
            if (typeof it === "string") list.push(it);
            else if (typeof it?.name === "string") list.push(it.name);
        }
    }
    const flags: Array<[string, any]> = [
        ["Efectivo", (kb as any).cash],
        ["Tarjeta débito/crédito", (kb as any).card || (kb as any).cards],
        ["Transferencia", (kb as any).transfer || (kb as any).wire],
        ["PSE", (kb as any).pse],
        ["Nequi", (kb as any).nequi],
        ["Daviplata", (kb as any).daviplata],
    ];
    for (const [label, v] of flags) if (v === true) list.push(label);
    return Array.from(new Set(list)).sort();
}

async function buildOrReuseSummary(args: {
    empresaId: number;
    conversationId: number;
    kb: EsteticaKB;
}): Promise<string> {
    const { empresaId, conversationId, kb } = args;

    const cached = await loadState(conversationId);
    const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
    if (fresh) return cached.summary!.text;

    // Solo config general; NADA de appointmentHours/Exceptions
    const apptCfg = await prisma.businessConfigAppt.findUnique({
        where: { empresaId },
        select: {
            appointmentEnabled: true,
            appointmentTimezone: true,
            appointmentBufferMin: true,
            appointmentMinNoticeHours: true,
            appointmentMaxAdvanceDays: true,
            allowSameDayBooking: true,
            defaultServiceDurationMin: true,
            appointmentPolicies: true,
            locationName: true,
            locationAddress: true,
            locationMapsUrl: true,
            parkingInfo: true,
            instructionsArrival: true,
            noShowPolicy: true,
            depositRequired: true,
            depositAmount: true,
            servicesText: true,
            services: true,
            kbBusinessOverview: true,
            kbFAQs: true,
            kbServiceNotes: true,
            kbEscalationRules: true,
            kbDisclaimers: true,
            kbMedia: true,
            kbFreeText: true,
        },
    });

    // === Horario desde BD (tu esquema: day,isOpen,start1,end1,start2,end2) ===
    const rawDays = await prisma.appointmentHour.findMany({
        where: { empresaId },
        select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });

    // Normaliza, ordena y arma tramos por día
    type DayRow = { day: string; isOpen: number | boolean; start1?: string | null; end1?: string | null; start2?: string | null; end2?: string | null };
    function formatDaysCompact(rows: DayRow[]) {
        if (!rows?.length) return "";

        // Ordena según L..D
        const sorted = rows
            .slice()
            .sort((a, b) => (DAY_ORDER[a.day] || 99) - (DAY_ORDER[b.day] || 99));

        const parts: string[] = [];

        for (const r of sorted) {
            const open = Number(r.isOpen) === 1 || r.isOpen === true;
            if (!open) continue;

            const spans: string[] = [];

            const s1 = hmToMin(r.start1), e1 = hmToMin(r.end1);
            if (s1 != null && e1 != null && e1 > s1) {
                spans.push(`${minToLabel(s1)}–${minToLabel(e1)}`);
            }

            const s2 = hmToMin(r.start2), e2 = hmToMin(r.end2);
            if (s2 != null && e2 != null && e2 > s2) {
                spans.push(`${minToLabel(s2)}–${minToLabel(e2)}`);
            }

            if (spans.length) {
                const label = DAY_LABEL[r.day] || r.day;
                parts.push(`${label} ${spans.join(", ")}`);
            }
        }

        return parts.join("; ");
    }

    let hoursLineFromDB = formatDaysCompact(rawDays as DayRow[]);


    // Pagos (opcional)
    const payments = paymentMethodsFromKB(kb);

    // Historial compacto
    const msgs = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: "desc" },
        take: 10,
        select: { from: true, contenido: true },
    });
    const history = msgs
        .reverse()
        .map((m) => `${m.from === MessageFrom.client ? "U" : "A"}: ${softTrim(m.contenido || "", 100)}`)
        .join(" | ");

    // Intento de extraer un horario "tal cual" desde KB/config, sin calcular
    // Horario con prioridad BD → KB → kbFreeText (sin “calcular”, sólo formateo)
    let hoursLine: string | null = null;

    // 1) BD (formateado con DAY_LABEL + minToLabel)
    if (hoursLineFromDB) hoursLine = hoursLineFromDB;

    // 2) KB (simple o general), si BD no trajo nada
    if (!hoursLine) {
        const hoursFromKB = (kb as any).hoursSimple || (kb as any).hours || null;
        if (hoursFromKB) hoursLine = String(hoursFromKB).trim();
    }

    // 3) kbFreeText (patrón "🕒 Horario: ...") como respaldo
    if (!hoursLine && apptCfg?.kbFreeText) {
        const m = String(apptCfg.kbFreeText).match(/🕒\s*Horario:\s*([^\n]+)/i);
        if (m) hoursLine = m[1].trim();
    }


    // FAQs (mismo parser que ya tenías)
    type FAQ = { q: string; a: string };
    function parseMaybeJson<T = any>(val: any): T | any {
        if (typeof val === "string") { try { return JSON.parse(val); } catch { } }
        return val;
    }
    function toFaqArray(src: any): FAQ[] {
        const v = parseMaybeJson(src);
        if (!v) return [];
        if (Array.isArray(v)) {
            if (v.length && typeof v[0] === "string") {
                return v.map((s: string) => {
                    const [q, a] = String(s).split("|");
                    return { q: (q || "").trim(), a: (a || "").trim() };
                }).filter(f => f.q && f.a);
            }
            if (v.length && typeof v[0] === "object") {
                return v.map((o: any) => ({
                    q: String(o?.q || "").trim(),
                    a: String(o?.a || "").trim(),
                })).filter(f => f.q && f.a);
            }
        }
        if (typeof v === "object") {
            return Object.entries(v).map(([q, a]) => ({
                q: String(q).trim(),
                a: String(a ?? "").trim(),
            })).filter(f => f.q && f.a);
        }
        if (typeof v === "string") {
            return v.split(/\r?\n/).map(l => {
                const [q, a] = l.split("|");
                return { q: (q || "").trim(), a: (a || "").trim() };
            }).filter(f => f.q && f.a);
        }
        return [];
    }
    const faqsFromCfg = toFaqArray(apptCfg?.kbFAQs);
    const faqsFromKB1 = toFaqArray((kb as any).kbFAQs);
    const faqsFromKB2 = toFaqArray((kb as any).faqs);
    const seen = new Set<string>();
    const faqsArr = [...faqsFromCfg, ...faqsFromKB1, ...faqsFromKB2]
        .filter(f => f && f.q && f.a)
        .filter(f => {
            const k = f.q.trim().toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

    function icon(label: "biz" | "tz" | "rules" | "log" | "pol" | "pay" | "svc" | "hrs" | "faq" | "note" | "hist") {
        const map = { biz: "🏥", tz: "🌐", rules: "📋", log: "📍", pol: "🧾", pay: "💳", svc: "✨", hrs: "🕒", faq: "💬", note: "📝", hist: "🧠" } as const;
        return map[label];
    }

    const S = apptCfg || ({} as any);
    const lines: string[] = [];
    lines.push(`${icon("biz")} *${kb.businessName || "Clínica estética"}*`);
    lines.push(`${icon("tz")} Zona horaria: ${S.appointmentTimezone || kb.timezone}`);

    const rulesArr = [
        S.appointmentEnabled != null ? `Agenda: ${S.appointmentEnabled ? "habilitada" : "deshabilitada"}` : "",
        (S.appointmentBufferMin ?? kb.bufferMin) != null ? `Buffer: ${S.appointmentBufferMin ?? kb.bufferMin} min` : "",
        S.allowSameDayBooking != null ? `Mismo día: ${S.allowSameDayBooking ? "sí" : "no"}` : "",
        S.appointmentMinNoticeHours != null ? `Anticipación: ${S.appointmentMinNoticeHours} h` : "",
        S.appointmentMaxAdvanceDays != null ? `Hasta: ${S.appointmentMaxAdvanceDays} días` : "",
    ].filter(Boolean);
    if (rulesArr.length) lines.push(`${icon("rules")} ${rulesArr.join(" · ")}`);

    const logArr = [
        S.locationName ? `Sede: ${S.locationName}` : "",
        S.locationAddress ? `Dir: ${S.locationAddress}` : "",
        S.locationMapsUrl ? `Mapa: ${S.locationMapsUrl}` : "",
        S.parkingInfo ? `Parqueadero: ${softTrim(S.parkingInfo, 120)}` : "",
        S.instructionsArrival ? `Ingreso: ${softTrim(S.instructionsArrival, 120)}` : "",
    ].filter(Boolean);
    if (logArr.length) lines.push(`${icon("log")} ${logArr.join(" · ")}`);

    if (S.noShowPolicy || S.depositRequired != null) {
        const pols = [
            S.noShowPolicy ? `No-show: ${softTrim(S.noShowPolicy, 120)}` : "",
            S.depositRequired ? `Depósito: ${S.depositAmount ? formatCOP(Number(S.depositAmount)) : "sí"}` : "Depósito: no",
        ].filter(Boolean);
        lines.push(`${icon("pol")} ${pols.join(" · ")}`);
    }

    if (payments.length) lines.push(`${icon("pay")} Pagos: ${payments.join(" • ")}`);

    const svcList = (kb.procedures ?? [])
        .filter(s => s.enabled !== false)
        .slice(0, 6)
        .map(s => s.priceMin ? `${s.name} (desde ${formatCOP(s.priceMin)})` : s.name)
        .join(" • ");
    if (svcList) lines.push(`${icon("svc")} Servicios: ${svcList}`);

    if (hoursLine) lines.push(`${icon("hrs")} Horario: ${hoursLine}`);

    if (faqsArr.length) {
        lines.push(`💬 *FAQs rápidas*`);
        for (const f of faqsArr.slice(0, 5)) {
            lines.push(`• ${softTrim(f.q, 60)} → ${softTrim(f.a, 140)}`);
        }
    }

    if (S.kbBusinessOverview) lines.push(`📝 ${softTrim(S.kbBusinessOverview, 260)}`);
    if (S.kbFreeText) lines.push(`📝 ${softTrim(S.kbFreeText, 260)}`);

    lines.push(`🧠 Historial: ${history || "—"}`);

    let compact = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    compact = softTrim(compact, 2400);

    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    return compact;
}


/* ===== Detección de handoff listo (nombre + fecha/hora textual + procedimiento) ===== */
function detectHandoffReady(t: string) {
    const text = (t || "").toLowerCase();

    const hasName =
        /\bmi\s+nombre\s+es\s+[a-záéíóúñü\s]{3,}/i.test(t) ||
        /\bsoy\s+[a-záéíóúñü\s]{3,}/i.test(t);

    const hasDateOrTimeText =
        /\b(hoy|mañana|manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|am|pm|tarde|mañana|manana|noche|mediod[ií]a|medio\s+dia)\b/.test(text) ||
        /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(text) ||
        /\b(\d{1,2}[:.]\d{2}\s*(am|pm)?)\b/.test(text);

    const hasProc =
        /\b(botox|toxina|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|laser|plasma|hilos|armonizaci[oó]n|mesoterapia)\b/.test(
            text
        );

    return hasName && hasDateOrTimeText && hasProc;
}

/* ====== NAME EXTRACTION (robusto) ====== */
// Palabras y frases que NO son nombre aunque sean un solo token válido
const NON_NAME_SINGLETONS = new Set([
    "hola", "holi", "hey", "buenos", "buenas", "dias", "días", "tardes", "noches",
    "gracias", "ok", "vale", "listo", "listos", "perfecto", "bien", "buen", "buenas!"
]);


// Stopwords y listas para corte/validación
const NAME_PARTICLES = new Set([
    "de", "del", "la", "las", "los", "da", "di", "do", "dos", "das", "van", "von"
]);

const HARD_STOPS = [
    ",", ".", ";", ":", "|", "/", "\\", " - ", " — ", " – ", "(", ")", "[", "]", "{", "}", "\n", "\r"
];

const CONTEXT_STOPS = new RegExp(
    [
        "\\b(para|por|con|sin|y|o|pero|aunque|porque|ya|listo|gracias|ok)\\b",
        "\\b(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|hoy|mañana|manana|tarde|noche|am|pm|a\\s*las|semana|mes)\\b",
        "\\b(botox|toxina|relleno|hialuronico|hialurónico|peeling|hidra|limpieza|depilación|depilacion|laser|plasma|hilos|armonización|armonizacion|mesoterapia)\\b",
        "\\b\\d{1,2}[:h\\.:-]?\\d{0,2}\\b",
        "\\b\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?\\b"
    ].join("|"),
    "i"
);

const EMAIL_OR_URL = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/\S+)\b/i;
const NON_NAME_CHARS = /[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-\s]/g;

// token de nombre válido (letras con acentos, admite ' y -)
const NAME_TOKEN = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\-]*$/;

// Normaliza espacios, quita emojis/ruido evidente
function stripJunk(s: string): string {
    let t = s.replace(EMAIL_OR_URL, " ");
    t = t.replace(/[0-9#*_~^`]+/g, " ");
    t = t.replace(NON_NAME_CHARS, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}

// Recorta en el primer delimitador fuerte o contexto sospechoso
function cutAtStops(s: string): string {
    for (const stop of HARD_STOPS) {
        const i = s.indexOf(stop);
        if (i > -1) s = s.slice(0, i);
    }
    const m = s.match(CONTEXT_STOPS);
    if (m && m.index !== undefined) s = s.slice(0, m.index);
    return s.trim();
}

// Capitaliza a Nombre Apellido (respetando partículas de/ del/…)
function normalizeNamePretty(n: string): string {
    const parts = n.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
        const low = p.toLowerCase();
        if (NAME_PARTICLES.has(low)) { out.push(low); continue; }
        const sub = p.split(/([-'])/).map(seg => {
            if (seg === "-" || seg === "'") return seg;
            return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
        }).join("");
        out.push(sub);
    }
    return out.join(" ");
}

// Valida que la secuencia parezca un nombre real
function looksValidNameSequence(seq: string): boolean {
    const parts = seq.split(/\s+/).filter(Boolean);
    if (!parts.length) return false;

    if (parts.length === 1) {
        const p = parts[0];
        if (!NAME_TOKEN.test(p)) return false;
        if (p.length < 2) return false;
        return true;
    }

    if (parts.length > 6) return false;

    let validTokens = 0;
    for (const p of parts) {
        if (NAME_PARTICLES.has(p.toLowerCase())) continue;
        if (NAME_TOKEN.test(p)) validTokens++;
    }
    return validTokens >= 2;
}

// Intenta extraer el span a partir de un trigger (soy|me llamo|mi nombre es|nombre:)
function spanAfterTrigger(text: string): string | null {
    const rx = /\b(?:soy|me\s+llamo|mi\s+nombre\s+es|nombre\s*:?)\s+(.{1,80})$/i;
    const m = text.match(rx);
    if (!m || !m[1]) return null;
    let span = m[1].trim();
    span = cutAtStops(span);
    span = stripJunk(span);
    if (!span) return null;
    return span;
}

// (REEMPLAZA) — extractor principal
// ——— SOLO acepta nombre con gatillo explícito; no intenta adivinar
function extractName(raw: string): string | null {
    if (!raw) return null;
    const rx = /\b(?:soy|me\s+llamo|mi\s+nombre\s+es|nombre\s*:?)\s+(.{1,80})$/i;
    const m = raw.match(rx);
    if (!m || !m[1]) return null;

    let span = m[1].trim();
    span = cutAtStops(span);
    span = stripJunk(span);
    if (!span) return null;

    const pretty = normalizeNamePretty(span);
    return looksValidNameSequence(pretty) ? pretty : null;
}


// (REEMPLAZA) — fallback “nombre suelto”
function looksLikeLooseName(raw: string): string | null {
    if (!raw) return null;
    let t = cutAtStops(stripJunk(raw));
    if (!t) return null;

    if (CONTEXT_STOPS.test(t)) return null;

    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && NON_NAME_SINGLETONS.has(tokens[0].toLowerCase())) {
        return null;
    }

    if (tokens.length < 1 || tokens.length > 6) return null;

    const pretty = normalizeNamePretty(t);
    if (!looksValidNameSequence(pretty)) return null;
    return pretty;
}


/** Extrae *solo* la preferencia temporal (día/fecha + hora) del texto del cliente */
function extractWhenPreference(raw: string): string | null {
    const t = String(raw || "");

    // Día + parte del día, con y sin "el"
    const patterns: RegExp[] = [
        // "el sábado en la mañana", "el martes en la tarde"
        /\bel\s+(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s+en\s+la\s+(mañana|manana|tarde|noche)\b/gi,
        // "sábado en la mañana"
        /\b(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s+en\s+la\s+(mañana|manana|tarde|noche)\b/gi,

        // Día + hora (ya existentes)
        /\b(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s*(?:\d{1,2}[:.]\d{2})?\s*(?:a\s*las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
        /\bel\s*(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\s*(?:a\s*las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,

        // Fecha numérica (ya existente)
        /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?(?:\s*(?:a\s*las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/gi,

        // Expresiones sueltas mejoradas
        /\b(sobre\s+las|tipo)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,              // "sobre las 3", "tipo 4 pm"
        /\bentre\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+y\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, // "entre 3 y 4 pm"
        /\b(a\s+primera\s+hora|al\s+mediod[ií]a|al\s+medio\s+dia)\b/gi,           // "a primera hora", "al mediodía"

        // Contexto relativo + posible hora (deja al final)
        /\b(hoy|mañana|manana|pr[oó]ximo\s+(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)|esta\s+semana|la\s+pr[oó]xima\s+semana)\b(?:.*?\b(?:a\s*las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
    ];

    const matches: string[] = [];
    for (const rx of patterns) {
        let m: RegExpExecArray | null;
        const copy = new RegExp(rx, rx.flags); // resettable
        while ((m = copy.exec(t)) !== null) {
            matches.push(m[0].replace(/\s+/g, " ").trim());
        }
    }

    if (matches.length) {
        // 1) Si alguna contiene día de la semana, priorízala
        const dayRx = /\b(lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo)\b/i;
        const withDay = matches.filter(x => dayRx.test(x));
        if (withDay.length) {
            // Devuelve la más larga (más contexto)
            return withDay.sort((a, b) => b.length - a.length)[0];
        }
        // 2) Si no hay día, devuelve la más larga
        return matches.sort((a, b) => b.length - a.length)[0];
    }

    // Fallback suave (evita devolver solo "mañana" si el texto tenía más)
    const hasHints =
        /\b(hoy|mañana|manana|lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[áa]bado|sabado|domingo|am|pm|a\s*las|semana|mes|mañana|manana)\b/i.test(t) ||
        /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/.test(t) ||
        /\b\d{1,2}[:.]\d{2}\b/.test(t);

    if (hasHints) return softTrim(raw, 60);
    return null;
}


function hasSomeDateDraft(d?: AgentState["draft"]) {
    return !!(d?.whenISO || d?.whenText);
}
function sanitizeGreeting(text: string, opts?: { allowFirstGreeting?: boolean }) {
    const allow = !!opts?.allowFirstGreeting;
    if (allow) return (text || "").trim(); // en el primer turno dejamos el saludo libre de la IA

    // En turnos posteriores, limpiamos saludos repetidos al inicio
    let s = (text || "").replace(/^[\s¡!¿?'"()\-–—]+/g, "").trim();
    const patterns = [
        /^(?:hola|holi|hey|buen(?:os|as)?\s+(?:d[ií]as|tardes|noches)|qué tal|que tal|hola hola)[\s,.:;!¡¿?–—-]*/i,
    ];
    for (const rx of patterns) s = s.replace(rx, "").trim();
    s = s.replace(/^(?:¡\s*)?hola[!\s,.:;¡¿?–—-]*/i, "").trim();
    return s || text;
}


/* ===== FORMATO / RESPUESTA ===== */
function clampText(t: string, lines = CONF.REPLY_MAX_LINES, chars = CONF.REPLY_MAX_CHARS) {
    let txt = (t || "").trim();
    if (!txt) return txt;
    const arr = txt.split("\n").filter(Boolean);
    if (arr.length > lines) txt = arr.slice(0, lines).join("\n");
    if (txt.length > chars) txt = txt.slice(0, chars - 3) + "…";
    return txt;
}

/** Normaliza texto para deduplicación (insensible a mayúsculas, tildes y espacios) */
function normalizeForDedup(s: string) {
    return (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")     // quita tildes
        .replace(/[\s\n\r]+/g, " ")         // colapsa espacios
        .replace(/[^\p{L}\p{N}\s]/gu, "")   // quita signos/emoji para comparar
        .trim();
}

/** Un solo emoji “premium” por conversación (estable) */
function addEmojiStable(text: string, conversationId: number) {
    const base = (Number.isFinite(conversationId) ? conversationId : 0) >>> 0;
    const emojis = ["✨", "👌", "🙂", "🫶", "💬"];
    const idx = base % emojis.length;
    if (/[✨👌🙂🫶💬]/.test(text)) return text;
    return `${text} ${emojis[idx]}`;
}

/* ===== PERSISTENCIA ===== */
function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}
async function persistBotReply({
    conversationId,
    empresaId,
    texto,
    nuevoEstado,
    to,
    phoneNumberId,
}: any) {
    // dedup suave con el último del bot:
    const prevBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { timestamp: "desc" },
        select: { id: true, contenido: true, timestamp: true, externalId: true },
    });
    if (prevBot) {
        const sameText =
            normalizeForDedup(prevBot.contenido || "") === normalizeForDedup(texto || "");
        const recent = Date.now() - new Date(prevBot.timestamp as any).getTime() <= 15_000;
        if (sameText && recent) {
            await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
            return { messageId: prevBot.id, texto: prevBot.contenido, wamid: prevBot.externalId as any, estado: nuevoEstado };
        }
    }

    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    });
    let wamid: string | undefined;
    if (to) {
        try {
            const r = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            });
            wamid = r?.data?.messages?.[0]?.id;
            if (wamid)
                await prisma.message.update({
                    where: { id: msg.id },
                    data: { externalId: wamid },
                });
        } catch { }
    }
    return { texto, wamid, messageId: msg.id };
}

/** ===== Saludo automático SOLO una vez (wrapper) ===== */
async function sendBotReply({
    conversationId,
    empresaId,
    texto,
    nuevoEstado,
    to,
    phoneNumberId,
}: {
    conversationId: number;
    empresaId: number;
    texto: string;
    nuevoEstado: ConversationEstado;
    to?: string | null;
    phoneNumberId?: string | null;
}) {
    // Enviamos el texto tal cual (la IA se encarga del saludo del primer turno)
    const saved = await persistBotReply({
        conversationId,
        empresaId,
        texto,
        nuevoEstado,
        to,
        phoneNumberId,
    });

    // Marcamos 'greeted' tras el primer envío si aún no estaba
    const st = await loadState(conversationId);
    if (!st.greeted) {
        await patchState(conversationId, { greeted: true });
    }
    return saved;
}


/* ===== OOT (fuera de alcance) ===== */
function isOutOfScope(text: string) {
    const t = (text || "").toLowerCase();
    const allowed =
        /(est[eé]tica|cl[ií]nica|botox|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|l[aá]ser|plasma|hilos|armonizaci[oó]n|mesoterapia|facial|corporal|agenda|cita|precio|valoraci[oó]n)/i;
    const disallowed =
        /(finanzas|banco|cript|programaci[oó]n|servidor|vercel|render|pol[ií]tica|relig|tarea de colegio|matem[aá]ticas|qu[ií]mica|f[úu]tbol|tr[aá]mite|veh[ií]culo)/i;
    return !allowed.test(t) && disallowed.test(t);
}

/* ===== LLM ===== */
async function runLLM({ summary, userText, imageUrl }: any) {
    const sys = [
        "Eres el asistente de una clínica estética.",
        "Tono humano, cálido y breve. Un solo saludo (solo en el primer turno) y a lo sumo un emoji.",
        "No des precios exactos; usa 'desde' si existe priceMin.",
        "No infieras horas: si el cliente escribe la hora, repítela tal cual; no calcules ni conviertas.",
        // === REGLAS DE HORARIOS ===
        "NO muestres horarios a menos que el usuario lo pida explícitamente (palabras como: horario, horarios, días, abren, atienden, trabajan, ‘¿de qué hora a qué hora?’).",
        "Si el usuario pregunta por servicios o precios, NO incluyas horarios en esa respuesta.",
        "Al mostrar horarios, usa SOLO lo que esté en el RESUMEN (no inventes, no completes, no asumas).",
        "Prefiere el bloque HORARIO_SIMPLE; si no existe, usa HORARIO. Si no hay ninguno, dilo de forma clara: 'Por ahora no tengo el horario en el sistema.'",
        "Formato corto de ejemplo (NO hardcodees): 'L 9am–1pm, 2pm–6pm; M 9am–1pm, 2pm–6pm; …'. Puedes usar abreviaturas L, M, X, J, V, S, D si el RESUMEN lo permite; si el RESUMEN ya trae otro formato, respétalo.",
        "Si preguntan por un día específico y ese día NO aparece en HORARIO_SIMPLE ni en HORARIO, responde claramente: 'Ese día no trabajamos en la clínica.'",
        // === ALCANCE Y FUENTES ===
        "Si faltan datos operativos (pagos/promos/etc.), responde: 'esa información se confirma en la valoración o directamente en la clínica'.",
        "Tu única fuente es el RESUMEN a continuación.",
        "\n=== RESUMEN ===\n" + summary + "\n=== FIN ===",
    ].join("\n");

    const messages: any[] = [{ role: "system", content: sys }];
    if (imageUrl) {
        messages.push({
            role: "user",
            content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: imageUrl } },
            ],
        });
    } else {
        messages.push({ role: "user", content: userText });
    }

    const r = await openai.chat.completions.create({
        model: CONF.MODEL,
        messages,
        temperature: CONF.TEMPERATURE,
        max_tokens: 220,
    });
    return r?.choices?.[0]?.message?.content?.trim() || "";
}

/** Clasificador semántico breve (responde SOLO JSON) */
async function classifyTurnLLM(userText: string): Promise<{ label: "book" | "ask_hours" | "ask_info" | "price" | "other"; confidence: number; }> {
    const sys = [
        "Eres un clasificador de intenciones de mensajes de clientes para una clínica estética.",
        "Tu respuesta debe ser SOLO un JSON en minúsculas con este formato exacto:",
        '{"label":"...", "confidence":0.0}',
        "Etiquetas posibles:",
        "- book: el usuario quiere AGENDAR o propone horario/fecha (ej.: 'quiero cita', 'puedo ir el viernes').",
        "- ask_hours: el usuario pregunta los horarios o días de atención (ej.: '¿qué días trabajan?', 'abren los domingos?').",
        "- ask_info: el usuario hace preguntas informativas sobre tratamientos, ubicación, precios, métodos de pago, duración, profesionales, riesgos, cuidados, etc.",
        "- price: el usuario pregunta directamente el precio o costo de un servicio.",
        "- other: cualquier otro mensaje que no tenga relación con estética o no pueda clasificarse.",
        "Reglas:",
        "- Si menciona 'agendar', 'cita', 'horario', 'reserva', 'puedo ir', 'quiero ir', 'agenda', 'programar' o 'día + hora', clasifica como 'book'.",
        "- Si pregunta solo 'qué días' o 'de qué hora a qué hora', clasifica como 'ask_hours'.",
        "- Si pregunta 'qué es', 'cómo funciona', 'beneficios', 'riesgos', 'contraindicaciones', 'dónde están', 'cómo pagar', clasifica como 'ask_info'.",
        "- Si menciona 'precio', 'cuánto vale', 'cuánto cuesta', 'desde', 'valor', clasifica como 'price'.",
        "- Si es un saludo, agradecimiento, emoji o texto vacío, devuelve 'other'.",
        "- Si el mensaje combina precio + cita, prioriza 'book'.",
        "Nunca devuelvas texto adicional, comentarios ni formato distinto al JSON. Ningún texto fuera del JSON."
    ].join("\n");


    const r = await openai.chat.completions.create({
        model: CONF.MODEL,
        temperature: 0,
        max_tokens: 40,
        messages: [
            { role: "system", content: sys },
            { role: "user", content: String(userText || "").slice(0, 500) }
        ]
    }).catch(() => null);

    try {
        const raw = r?.choices?.[0]?.message?.content?.trim() || "";
        const parsed = JSON.parse(raw);
        if (parsed?.label) {
            return {
                label: parsed.label,
                confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7))),
            };
        }
    } catch { }
    return { label: "other", confidence: 0.5 };
}


/* ===== Núcleo (estrategia) ===== */
export async function handleEsteticaStrategy({
    chatId,
    empresaId,
    mensajeArg = "",
    toPhone,
    phoneNumberId,
}: {
    chatId: number;
    empresaId: number;
    mensajeArg?: string;
    toPhone?: string;
    phoneNumberId?: string;
}) {
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, phone: true, estado: true },
    });
    if (!conversacion) return null;

    // Guard si ya está bloqueado por handoff
    const statePre = await loadState(chatId);
    if (conversacion.estado === ConversationEstado.requiere_agente || statePre.handoffLocked) {
        return { estado: "pendiente", mensaje: "" };
    }

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: {
            id: true,
            contenido: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            mimeType: true,
            isVoiceNote: true,
            transcription: true,
            timestamp: true,
        },
    });
    if (last?.id && seenInboundRecently(last.id)) return null;
    if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp)) return null;

    let userText = (mensajeArg || "").trim();

    // Voz → transcribir
    if (!userText && isVoiceInbound(last || {})) {
        let tr = last?.transcription?.trim() || "";
        if (!tr && last?.mediaUrl) {
            try {
                const { data } = await axios.get(last.mediaUrl, { responseType: "arraybuffer" });
                tr = await transcribeAudioBuffer(Buffer.from(data), "audio.ogg");
                if (tr)
                    await prisma.message.update({ where: { id: last.id }, data: { transcription: tr } });
            } catch { }
        }
        if (tr) userText = tr;
    }
    if (!userText) userText = last?.contenido?.trim() || "";

    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) {
        const msg = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: msg,
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { handoffLocked: true });
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    const { url: imageUrl, noteToAppend } = await pickImageForContext({
        conversationId: chatId,
        userText,
        caption: last?.caption || "",
        referenceTs: last?.timestamp || new Date(),
    });
    if (noteToAppend) userText += noteToAppend;

    // ====== Agendamiento flexible (colecta progresiva sin calcular hora) ======
    // 1) Actualiza draft con lo que venga en texto
    let state = await loadState(chatId);
    let nameInText = extractName(userText);

    if (!nameInText) {
        const stateNow = await loadState(chatId);
        const needNameNow = !(stateNow.draft?.name);
        if (needNameNow) {
            const loose = looksLikeLooseName(userText);
            if (loose) nameInText = loose;
        }
    }


    let match = resolveServiceName(kb, userText || "");
    if (!match.procedure) {
        const t = (userText || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        // Diccionario muy corto de palabras-clave → chequeo por nombre/alias
        const hints = [
            { kw: /\b(botox|toxina)\b/, pick: /toxina|b[oó]tox/ },
            { kw: /\blimpieza\b/, pick: /limpieza|hydra|hidra/ },
            { kw: /\bpeeling\b/, pick: /peeling/ },
            { kw: /\b(hialuron|relleno)\b/, pick: /hialur[oó]nico|relleno/ },
            { kw: /\b(l[aá]ser|laser)\b/, pick: /laser|l[aá]ser/ },
            { kw: /\b(meso|mesoterapia)\b/, pick: /mesoterapia/ },
        ];
        const tryPick = (rxPick: RegExp) => {
            return kb.procedures.find(p => {
                const name = (p.name || "").toLowerCase();
                const aliases = Array.isArray(p.aliases) ? p.aliases.join(" ").toLowerCase() : "";
                return rxPick.test(name) || rxPick.test(aliases);
            }) || null;
        };
        for (const h of hints) {
            if (h.kw.test(t)) {
                const found = tryPick(h.pick);
                if (found) { match = { procedure: found, matched: found.name }; break; }
            }
        }
    }


    const prevDraft = state.draft ?? {};
    const whenFreeCandidate = extractWhenPreference(userText);
    const clsForWhen = await classifyTurnLLM(userText);
    const canCaptureWhen =
        hasBookingIntent(userText) ||
        clsForWhen.label === "book" ||
        hasConcreteTimeAnchor(userText);

    const newDraft = {
        ...prevDraft,
        name: prevDraft.name || nameInText || undefined,
        procedureId: prevDraft.procedureId || (match.procedure?.id ?? undefined),
        procedureName: prevDraft.procedureName || (match.procedure?.name ?? undefined),
        // whenISO: opcional—solo si detectas una fecha explícita tipo 12/11; aquí no forzamos
        whenISO: prevDraft.whenISO || undefined,
        whenText: prevDraft.whenText || (canCaptureWhen ? whenFreeCandidate : null) || undefined,
        // textual SIEMPRE
    };
    const inferredIntent = await detectIntentSmart(userText, newDraft);

    await patchState(chatId, { draft: newDraft, lastIntent: inferredIntent });

    // 2) Handoff solo si tenemos las 3 piezas EN EL DRAFT (sin regex del texto)
    if (newDraft.name && newDraft.procedureName && hasSomeDateDraft(newDraft)) {
        const piezasBonitas = [
            `💆 *Tratamiento:* ${newDraft.procedureName ?? "—"}`,
            `👤 *Nombre:* ${newDraft.name}`,
            newDraft.whenText
                ? `🗓️ *Preferencia:* ${newDraft.whenText}`
                : (newDraft.whenISO
                    ? `🗓️ *Fecha:* ${new Date(newDraft.whenISO).toLocaleDateString("es-CO", {
                        weekday: "long",
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                    })}`
                    : ""),
        ].filter(Boolean).join("\n");

        let cleaned = `Perfecto ✨, dame *unos minutos* mientras *verifico la disponibilidad* para ese horario y te confirmo por aquí.\n\n${piezasBonitas}`;

        cleaned = sanitizeGreeting(cleaned, { allowFirstGreeting: false });
        cleaned = cleaned.replace(/\bmi\s+nombre\s+es\s+[A-ZÁÉÍÓÚÑa-záéíóúñü\s]+/gi, "").trim();
        cleaned = addEmojiStable(cleaned, chatId);

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: clampText(cleaned),
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { handoffLocked: true });
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // 3) Si está fuera de alcance → redirige suave
    if (isOutOfScope(userText)) {
        const txt =
            "Puedo ayudarte con información de nuestros servicios estéticos y agendar tu cita. ¿Qué procedimiento te interesa o para qué fecha te gustaría programar? 🙂";

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: txt,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ——— Respuesta directa a “qué servicios”
    if (/\b(que\s+servicios|qué\s+servicios|servicios\s+ofreces?)\b/i.test(userText)) {
        const serviciosBonitos = formatServicesPretty(kb, 8);

        let texto = `${serviciosBonitos}\n\nSi alguno te interesa, dime el *día y hora* que prefieres para agendar y lo verifico.`;
        texto = clampText(addEmojiStable(texto, chatId));

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { lastIntent: "schedule" });
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ===== Pedir piezas SOLO si hay intención de agenda o ya hay piezas
    const needProcedure = !newDraft.procedureId && !newDraft.procedureName;
    const needWhen = !hasSomeDateDraft(newDraft);
    const needName = !newDraft.name;

    const hasServiceOrWhen = !!(newDraft.procedureId || newDraft.procedureName || newDraft.whenText || newDraft.whenISO);
    const infoBreaker = shouldBypassScheduling(userText);

    const summary = await buildOrReuseSummary({ empresaId, conversationId: chatId, kb });


    const shouldAskForAgendaPieces =
        !infoBreaker && (inferredIntent === "schedule" || hasServiceOrWhen);


    if (shouldAskForAgendaPieces && (needProcedure || needWhen || needName)) {
        const asks: string[] = [];
        if (needProcedure) {
            const sample = kb.procedures.slice(0, 3).map(s => s.name).join(", ");
            asks.push(`¿Para qué *tratamiento* deseas la cita? (Ej.: ${sample})`);
        }
        if (needWhen) {
            asks.push(`¿Qué *día y hora* prefieres? Escríbelo *tal cual* (ej.: “martes en la tarde” o “15/11 a las 3 pm”).`);
        }
        if (needName) {
            asks.push(`¿Cuál es tu *nombre completo*?`);
        }
        let texto = clampText(asks.join(" "));
        texto = addEmojiStable(texto, chatId);

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ===== Respuesta libre (modo natural) usando el summary extendido
    let texto = await runLLM({ summary, userText, imageUrl }).catch(() => "");
    const wasGreeted = (await loadState(chatId)).greeted; // ya tenemos 'state', pero aseguramos valor fresco
    texto = sanitizeGreeting(texto, { allowFirstGreeting: !wasGreeted });

    texto = clampText(texto || "¡Hola! ¿Prefieres info de tratamientos o ver opciones para agendar?");
    texto = addEmojiStable(texto, chatId);

    const saved = await sendBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    });

    if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    };
}

/* ===== WRAPPER COMPATIBLE CON EL ORQUESTADOR ===== */
export async function handleEsteticaReply(args: {
    chatId?: number;
    conversationId?: number;
    empresaId: number;
    contenido?: string;
    toPhone?: string;
    phoneNumberId?: string;
}): Promise<{
    estado: "pendiente" | "respondido" | "en_proceso" | "requiere_agente";
    mensaje: string;
    messageId?: number;
    wamid?: string;
    media?: any[];
}> {
    const {
        chatId,
        conversationId: conversationIdArg,
        empresaId,
        contenido,
        toPhone,
        phoneNumberId,
    } = args;

    const conversationId = conversationIdArg ?? chatId;
    if (!conversationId) return { estado: "pendiente", mensaje: "" };

    const res = await handleEsteticaStrategy({
        chatId: conversationId,
        empresaId,
        mensajeArg: (contenido || "").trim(),
        toPhone,
        phoneNumberId,
    });

    if (!res) return { estado: "pendiente", mensaje: "" };

    return {
        estado: (res.estado as any) || ConversationEstado.respondido,
        mensaje: res.mensaje || "",
        messageId: res.messageId,
        wamid: res.wamid,
        media: res.media || [],
    };
}

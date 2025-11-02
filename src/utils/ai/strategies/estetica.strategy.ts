
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
type Conf = {
    MEM_TTL_MIN: number;
    GRAN_MIN: number;
    MAX_HISTORY: number;
    REPLY_MAX_LINES: number;
    REPLY_MAX_CHARS: number;
    TEMPERATURE: number;
    MODEL: string;

    // ← ahora requeridos
    NAME_ACCEPT_STRICT: boolean;
    NAME_LLM_ENABLED: boolean;
    NAME_LLM_CONF_MIN: number;

};

const CONF: Conf = {
    MEM_TTL_MIN: 60,
    GRAN_MIN: 15,
    MAX_HISTORY: 20,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.3,
    MODEL: process.env.IA_TEXT_MODEL || "gpt-4o-mini",

    // defaults para evitar undefined en tiempo de ejecución
    NAME_ACCEPT_STRICT: true,   // acepta solo con gatillo (soy/me llamo/mi nombre es)
    NAME_LLM_ENABLED: true,     // permite NER por LLM como sugerencia
    NAME_LLM_CONF_MIN: 0.85,    // umbral de confianza para sugerir


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

function isYes(text: string) {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    // incluye yes/yep/affirmative + emojis 👍👌
    return /\b(si|sí|correcto|as[ií]\s*es|de acuerdo|ok|vale|exacto|yes|yep|affirmative)\b/.test(t)
        || /[👍👌]/.test(text || "");
}
function isNo(text: string) {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    // incluye no/nope/negative + emoji 👎
    return /\b(no|negativo|no es|cambia|otro|nope|negative)\b/.test(t)
        || /[👎]/.test(text || "");
}


function norm(s: string) {
    return (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
async function askedRecentlyForName(conversationId: number, withinMs = 90_000) {
    const prev = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { timestamp: "desc" },
        select: { contenido: true, timestamp: true },
    });
    if (!prev) return false;
    const t = norm(prev.contenido || "");
    const asked =
        /\bcual es tu nombre completo\b/.test(t) ||
        /\bme llamo\b.*\bnombre\b/.test(t) ||
        /\bnombre completo\b/.test(t);
    const recent = Date.now() - new Date(prev.timestamp as any).getTime() <= withinMs;
    return asked && recent;
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

function normalizeWhenPreview(raw?: string | null): string | undefined {
    if (!raw) return undefined;
    const t = raw.trim();

    // Día (Lun..Dom) compacto
    const d = t.toLowerCase()
        .replace(/lunes/i, "Lun")
        .replace(/martes/i, "Mar")
        .replace(/mi[eé]rcoles|miercoles/i, "Mié")
        .replace(/jueves/i, "Jue")
        .replace(/viernes/i, "Vie")
        .replace(/s[áa]bado|sabado/i, "Sáb")
        .replace(/domingo/i, "Dom");

    // Parte del día simple
    let part = "";
    if (/\b(mañana|manana)\b/i.test(d)) part = "AM";
    else if (/\b(tarde)\b/i.test(d)) part = "PM";
    else if (/\b(noche)\b/i.test(d)) part = "NOCHE";

    // Hora aproximada: “~16:00” si hay número
    const hm = d.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    let hhmm = "";
    if (hm) {
        let h = parseInt(hm[1], 10);
        const m = hm[2] ? parseInt(hm[2], 10) : 0;
        const ampm = (hm[3] || "").toLowerCase();
        if (ampm === "pm" && h < 12) h += 12;
        if (ampm === "am" && h === 12) h = 0;
        hhmm = `~${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        if (!part) part = (h >= 12 && h < 19) ? "PM" : (h >= 19 ? "NOCHE" : "AM");
    }

    // Día corto si lo hay
    const dayShort = (d.match(/\b(Lun|Mar|Mié|Jue|Vie|Sáb|Dom)\b/i)?.[0]) || "";

    return [dayShort, part && `(${part})`, hhmm].filter(Boolean).join(" ").trim();
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
        whenText?: string; // textual tal cual
        whenPreview?: string;
        pendingConfirm?: {
            name?: string; // ← sugerencia de nombre pendiente de “sí / no”
        };
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

function shouldBypassScheduling(t: string, hasPartialAgenda: boolean): boolean {
    if (isSchedulingCue(t) || containsDateOrTimeHints(t)) return false;
    if (hasPartialAgenda) return false;
    if (isShortQuestion(t) || isGeneralInfoQuestion(t) || isEducationalQuestion(t)) return true;
    return false;
}

type Intent = "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";

function detectIntent(text: string, draft: AgentState["draft"]): Intent {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

    // explícitos
    const scheduleHints = [
        "agendar", "agendo", "agendemos", "agenda", "cita", "programar", "reservar", "reserva",
        "disponible", "disponibilidad", "horario", "hora", "dia", "fecha", "cuando atienden", "para el",
        "quiero ir", "puedo ir", "mañana", "manana", "tarde", "noche", "am", "pm", "a las"
    ];
    if (scheduleHints.some(h => t.includes(h))) return "schedule";

    // ⚠️ ya NO activamos schedule por el solo hecho de tener procedure en el draft
    // (solo será schedule si hay intención explícita o ancla temporal)
    if (hasConcreteTimeAnchor(t) && hasBookingIntent(t)) return "schedule";

    if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";
    if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";
    if (/\b(que es|como funciona|efectos|riesgos|duracion|contraindicaciones|recomendaciones)\b/.test(t)) return "info";

    return "other";
}


async function detectIntentSmart(text: string, draft: AgentState["draft"]): Promise<Intent> {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

    if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";
    if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";

    const cls = await classifyTurnLLM(text);
    const wantBook = hasBookingIntent(t) || cls.label === "book";
    const hasTimeAnchor = hasConcreteTimeAnchor(t);

    if (wantBook && hasTimeAnchor) return "schedule";

    // Si pregunta “horarios”, trátalo como info (no agenda)
    if (cls.label === "ask_hours") return "info";

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

// [REEMPLAZO] — 1 sola pregunta por turno (prioridad: procedure → when → name)
function buildAskPiecesText(kb: EsteticaKB, need: { proc: boolean; when: boolean; name: boolean }) {
    if (need.proc) {
        const sample = (kb.procedures || [])
            .filter(p => p.enabled !== false)
            .slice(0, 3)
            .map(s => s.name)
            .join(", ");
        return `¿Para qué *tratamiento* deseas la cita? (Ej.: ${sample || "Limpieza, Peeling, Toxina"})`;
    }
    if (need.when) {
        return `¿Qué *día y hora* prefieres? Escríbelo *tal cual* (ej.: “martes en la tarde” o “15/11 a las 3 pm”).`;
    }
    if (need.name) {
        return `¿Cuál es tu *nombre completo*? (Ej.: *Me llamo* Ana María Gómez)`;
    }
    return "";
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

function getSlaConfirmText(kb: EsteticaKB) {
    // Busca en KB o deja default
    const raw = (kb as any)?.slaConfirmText || (kb as any)?.appointmentSlaText || "";
    const t = String(raw || "").trim();
    return t || "unos minutos"; // ejemplo configurable: "5–15 min"
}



// variable reutilizable para evitar "Cannot redeclare block-scoped variable 'summary'"
let summaryText: string = "";

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

    // === META solo para la IA (no visible al cliente) ===
    // Colócalo antes de "🧠 Historial: ..."

    // 1) Staff general (compacto)
    if ((kb.staff ?? []).length) {
        const staffMeta: string[] = [];
        staffMeta.push("=== STAFF ===");
        for (const s of kb.staff) {
            // formatea rol en minúsculas legibles
            const role = String(s.role || "").toLowerCase();
            staffMeta.push(`- id=${s.id}; name=${s.name}; role=${role}; active=${s.active ? "1" : "0"}`);
        }
        staffMeta.push("=== FIN_STAFF ===");
        lines.push(staffMeta.join("\n"));
    }

    // 2) Catálogo con duración y staff requerido por procedimiento
    if ((kb.procedures ?? []).length) {
        const staffById = new Map((kb.staff ?? []).map(s => [s.id, s.name]));

        const catMeta: string[] = [];
        catMeta.push("=== CATALOGO_DETALLE ===");
        for (const p of kb.procedures) {
            if (p?.enabled === false) continue;

            // duración: prioriza la del procedimiento; si no, usa defaultServiceDurationMin
            const dur =
                (p.durationMin != null ? p.durationMin : (kb.defaultServiceDurationMin ?? null));
            const durTxt = dur != null ? `${dur}min` : "NA";

            // staff requerido (si aplica)
            const staffReq = (p.requiredStaffIds ?? [])
                .map(id => staffById.get(id))
                .filter(Boolean) as string[];
            const staffTxt = staffReq.length ? staffReq.join(", ") : "libre";

            // precio min como referencia para la IA (no para mostrar)
            const priceTxt = p.priceMin != null ? `${Number(p.priceMin)}` : "NA";

            catMeta.push(`- proc=${p.name}; dur=${durTxt}; staff=${staffTxt}; priceMinCOP=${priceTxt}`);
        }
        catMeta.push("=== FIN_CATALOGO ===");
        lines.push(catMeta.join("\n"));
    }


    lines.push(`🧠 Historial: ${history || "—"}`);

    let compact = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    compact = softTrim(compact, 2400);

    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    return compact;
}

/* === OVERLAY: inyecta piezas de agenda (procedimiento, nombre, fecha) en el summary sin romper el caché === */
function overlayAgenda(summary: string, draft?: AgentState["draft"]): string {
    const t = (draft?.procedureName || "").trim();
    const n = (draft?.name || "").trim();
    const w = (draft?.whenText || (draft?.whenISO ? new Date(draft.whenISO).toISOString() : "")).trim();

    const agenda = [
        "=== AGENDA_COLECTADA ===",
        `tratamiento: ${t || "—"}`,
        `nombre: ${n || "—"}`,
        `preferencia: ${w || "—"}`,
        "=== FIN_AGENDA ===",
    ].join("\n");

    // Quita bloque previo si existiera, luego inserta uno fresco al final
    const cleaned = summary
        .replace(/=== AGENDA_COLECTADA ===[\s\S]*?=== FIN_AGENDA ===/g, "")
        .trim();

    return `${cleaned}\n\n${agenda}`;
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
const NON_NAME_WORDS_RX = new RegExp(
    String.raw`\b(
      hola|buenos|buenas|dias|días|tardes|noches|gracias|ok|vale|listo|perfecto|
      quiero|quisiera|puedo|necesito|me|gustaria|gustaría|agendar|agenda|cita|reservar|disponible|disponibilidad|
      precio|costo|vale|cuanto|cuánto|tratamiento|botox|toxina|relleno|peeling|hidra|limpieza|laser|l[aá]ser|mesoterapia|
      dia|día|fecha|hora|tarde|mañana|manana|noche|hoy|mañana|manana|proximo|pr[oó]ximo|semana|cuando|cu[aá]ndo|que|qu[eé]
    )\b`,
    "i"
);

// (REEMPLAZA) — fallback “nombre suelto” con filtros fuertes
function looksLikeLooseName(raw: string): string | null {
    if (!raw) return null;

    // Si trae signos de pregunta/exclamación o comas, es muy probable que NO sea un nombre
    if (/[?¿!¡,;:]/.test(raw)) return null;

    // Si contiene palabras típicas de intención, fechas/horas o servicios → NO es nombre
    if (NON_NAME_WORDS_RX.test(raw)) return null;

    // Limpieza y cortes básicos
    let t = cutAtStops(stripJunk(raw));
    if (!t) return null;

    // Evita que el contexto “sospechoso” sobreviva
    if (CONTEXT_STOPS.test(raw)) return null;

    const tokens = t.split(/\s+/).filter(Boolean);

    // Aceptamos 2–4 tokens como “nombre suelto”; 1 token solo si es largo (≥3)
    if (tokens.length === 1) {
        const one = tokens[0];
        if (NON_NAME_SINGLETONS.has(one.toLowerCase())) return null;
        if (one.length < 3) return null;
    } else {
        if (tokens.length < 2 || tokens.length > 4) return null;
    }

    // Todos los tokens deben ser “tipo nombre” o partículas, no verbos/comunes
    for (const tok of tokens) {
        const low = tok.toLowerCase();
        if (NAME_PARTICLES.has(low)) continue;
        // Si parece verbo/común (heurística): termina en -ar/-er/-ir o es muy genérica
        if (/(ar|er|ir)$/.test(low)) return null;
    }

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

// Quita emojis/variantes del texto del LLM para evitar duplicados antes de addEmojiStable
function stripEmojis(s: string) {
    // rangos amplios + VS16
    return (s || "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, "");
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

// Para respuestas informativas: 4 líneas máx (sin tocar el global)
function clampInfoText(t: string) {
    return clampText(t, Math.min(CONF.REPLY_MAX_LINES, 4), CONF.REPLY_MAX_CHARS);
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

// Agrega un tail si no fue dicho recientemente por el bot
async function appendOnceInvitationTail(
    conversationId: number,
    body: string,
    tail: string
) {
    // 1) Si el propio cuerpo ya tiene CTA → no añadir
    if (bodyHasCTA(body)) return body;

    // 2) Evita repetir si el último bot ya lo mandó
    const prev = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { timestamp: "desc" },
        select: { contenido: true }
    });
    const norm = normalizeForDedup;
    if (prev && norm(prev.contenido || "").includes(norm(tail))) {
        return body;
    }

    return `${body}\n\n${tail}`;
}


// === CTA único y detector de CTA en el cuerpo ===
const CTA_UNICO =
    "¿Te gustaría agendar una cita? Si es así, cuéntame *tratamiento*, *día y hora* (tal cual) y tu *nombre completo*.";

const CTA_RX = /\b(te\s+gustaria\s+agendar|si\s+(?:luego\s+)?quieres\s+agendar|si\s+deseas\s+agendar|agendar\s+una\s+cita|agendamos)\b/i;

function bodyHasCTA(s: string) {
    return CTA_RX.test(normalizeForDedup(s));
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
        "No te presentes de nuevo después del primer turno (no digas 'soy el asistente...' ni repitas bienvenida).",
        "Evita saludos duplicados en turnos posteriores; ve directo a la respuesta.",

        // === HORARIOS ===
        "NO muestres horarios a menos que el usuario lo pida explícitamente (horario/horarios/días/abren/atienden/'¿de qué hora a qué hora?').",
        "Si el usuario pregunta por servicios o precios, NO incluyas horarios.",
        "Al mostrar horarios, usa SOLO lo que esté en el RESUMEN; no inventes ni asumas.",
        "Si no hay horario en el RESUMEN, dilo de forma natural sin culpar al resumen (ej.: 'Por ahora no tengo el horario en el sistema.').",
        "Si preguntan por un día que no aparece, responde claro (ej.: 'Ese día no trabajamos.').",

        // === COLECTA PROGRESIVA VÍA AGENDA ===
        "El RESUMEN incluye un bloque AGENDA_COLECTADA con 3 piezas: tratamiento, nombre, preferencia (día/hora).",
        "Pide SOLO una pieza faltante por turno, en este orden: tratamiento → día/hora → nombre.",
        "Si ya están las 3 piezas, NO prometas cupos ni confirmes; di que vas a validar disponibilidad y que un asesor continúa.",
        "No digas 'en el resumen no se especifica' ni 'no veo en el resumen'; habla en primera persona y pregunta de forma natural.",
        "Evita forzar agenda cuando el cliente hace preguntas informativas; primero responde su duda y luego invita suave a aportar la siguiente pieza si procede.",

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

async function extractEntitiesLLM(userText: string): Promise<{ name?: string; confidence?: number }> {
    if (!CONF.NAME_LLM_ENABLED) return {};
    const sys = [
        "Eres un extractor de entidades para una clínica estética.",
        "Devuelve SOLO un JSON minúsculo: {\"name\":\"\",\"confidence\":0.0}",
        "Reglas:",
        "- name: extrae el nombre completo del cliente SOLO si está presente en el texto.",
        "- No inventes ni asumas. Si no hay nombre claro, deja \"name\" vacío.",
        "- Penaliza fuertemente si hay días/horas/servicios pegados al lado del posible nombre.",
        "- Prioriza patrones con gatillos ('soy', 'me llamo', 'mi nombre es').",
    ].join("\n");

    const r = await openai.chat.completions.create({
        model: CONF.MODEL,
        temperature: 0,
        max_tokens: 60,
        messages: [
            { role: "system", content: sys },
            { role: "user", content: String(userText || "").slice(0, 400) }
        ]
    }).catch(() => null);

    try {
        const raw = r?.choices?.[0]?.message?.content?.trim() || "";
        const parsed = JSON.parse(raw);
        const name = String(parsed?.name || "").trim();
        const conf = Number(parsed?.confidence ?? 0);
        if (!name) return {};
        return { name, confidence: isFinite(conf) ? conf : 0.0 };
    } catch { return {}; }
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
    // ====== Agendamiento flexible (colecta progresiva sin calcular hora) ======
    let state = await loadState(chatId);

    // 1º intenta con gatillos (soy / me llamo / mi nombre es)
    // 2º si no, usa el detector robusto de nombre "suelto" (validado)
    let nameInText: string | null = null;
    let nameSource: "trigger" | "loose" | "llm" | null = null;

    // Declarar nextName ANTES de usarlo
    const prevDraft = state.draft ?? {};
    let nextName: string | undefined = prevDraft.name;

    // 1) Gatillos (alta precisión) → aceptar directo
    const byTrigger = extractName(userText);
    if (byTrigger) {
        nameInText = byTrigger;
        nameSource = "trigger";
        nextName = byTrigger; // fijamos directo y NO pedimos confirmación

    } else {

        // 2) Loose (si el mensaje es SOLO el nombre) → podemos aceptar directo aun en modo estricto
        const byLoose = looksLikeLooseName(userText);

        // Heurística: “solo nombre”, sin signos ni palabras de contexto
        const onlyNameNoContext =
            !!byLoose &&
            !/[?¿!¡,;:]/.test(userText) &&
            !NON_NAME_WORDS_RX.test(userText) &&
            !CONTEXT_STOPS.test(userText);

        if (byLoose && onlyNameNoContext) {
            // ✅ Aceptación silenciosa, incluso con NAME_ACCEPT_STRICT = true
            nameInText = byLoose;
            nameSource = "loose";
            nextName = byLoose; // ← fijamos directo, NO pedimos confirmación
        } else if (byLoose && CONF.NAME_ACCEPT_STRICT !== true) {
            // modo laxo: sugerencia directa (también se podría fijar)
            nameInText = byLoose;
            nameSource = "loose";
        } else {
            // 3) LLM NER (sugerencia) → requiere confirmación + umbral
            const ent = await extractEntitiesLLM(userText);
            if (ent?.name && (ent.confidence ?? 0) >= CONF.NAME_LLM_CONF_MIN) {
                const cleaned = looksLikeLooseName(ent.name) || extractName(`mi nombre es ${ent.name}`);
                if (cleaned) {
                    nameInText = cleaned;
                    nameSource = "llm";
                }
            }
        }

    }

    // Resolver procedimiento (se mantiene igual)
    let match = resolveServiceName(kb, userText || "");
    if (!match.procedure) {
        const t = (userText || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
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

    const whenFreeCandidate = extractWhenPreference(userText);
    const clsForWhen = await classifyTurnLLM(userText);
    const canCaptureWhen =
        hasBookingIntent(userText) ||
        clsForWhen.label === "book" ||
        hasConcreteTimeAnchor(userText);

    let pendingConfirm = prevDraft.pendingConfirm || undefined;

    // si viene por gatillo, se fija directo.
    // si viene por loose/llm → va a confirmación (a menos que ya teníamos name)
    if (!prevDraft.name && nameInText && nameSource !== "trigger") {
        pendingConfirm = { ...(pendingConfirm || {}), name: nameInText! };
    }

    const whenTextNext = (canCaptureWhen && whenFreeCandidate)
        ? whenFreeCandidate
        : prevDraft.whenText || undefined;

    const newDraft = {
        ...prevDraft,
        name: nextName,
        pendingConfirm,
        procedureId: (match.procedure?.id && match.procedure?.id !== prevDraft.procedureId)
            ? match.procedure.id
            : prevDraft.procedureId,
        procedureName: (match.procedure?.name && match.procedure?.name !== prevDraft.procedureName)
            ? match.procedure.name
            : prevDraft.procedureName,

        whenISO: prevDraft.whenISO || undefined,
        whenText: whenTextNext,
        whenPreview: whenTextNext ? normalizeWhenPreview(whenTextNext) : prevDraft.whenPreview, // ← NUEVO
    };



    const inferredIntent = await detectIntentSmart(userText, newDraft);

    await patchState(chatId, { draft: newDraft, lastIntent: inferredIntent });

    // ——— Confirmación de nombre pendiente (si aplica)
    if (newDraft.pendingConfirm?.name && !newDraft.name) {
        if (isYes(userText)) {
            // Confirmado → fijamos nombre
            newDraft.name = newDraft.pendingConfirm.name;
            newDraft.pendingConfirm = undefined;
            await patchState(chatId, { draft: newDraft });
        } else if (isNo(userText)) {
            // Rechazado → pedimos el nombre con gatillo
            newDraft.pendingConfirm = undefined;
            await patchState(chatId, { draft: newDraft });
            const ask = "Gracias. ¿Cuál es tu *nombre completo*? (ej.: *Me llamo* Ana María Gómez)";
            const saved = await sendBotReply({
                conversationId: chatId,
                empresaId,
                texto: addEmojiStable(clampText(ask), chatId),
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } else {
            // Aún no hubo sí/no → preguntar explícitamente
            const ask = `¿Te registro como *${newDraft.pendingConfirm.name}*?`;
            const saved = await sendBotReply({
                conversationId: chatId,
                empresaId,
                texto: addEmojiStable(clampText(ask), chatId),
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
            await patchState(chatId, { draft: newDraft });
            return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

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

        const slaText = getSlaConfirmText(kb);
        let cleaned = `Perfecto ✨, dame *${slaText}* mientras *verifico la disponibilidad* para ese horario y te confirmo por aquí.\n\n${piezasBonitas}`;

        cleaned = sanitizeGreeting(cleaned, { allowFirstGreeting: false });
        cleaned = cleaned.replace(/\bmi\s+nombre\s+es\s+[A-ZÁÉÍÓÚÑa-záéíóúñü\s]+/gi, "").trim();
        cleaned = stripEmojis(cleaned);                   // ← NUEVO
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
        await patchState(chatId, { lastIntent: "info" });

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
    let needName = !newDraft.name; // <— cambia a let

    if (needName && await askedRecentlyForName(chatId)) {
        // ya lo pedimos hace muy poco; evita repetir la misma pregunta
        needName = false;
    }

    const hasServiceOrWhen = !!(newDraft.procedureId || newDraft.procedureName || newDraft.whenText || newDraft.whenISO);
    const infoBreaker = shouldBypassScheduling(
        userText,
        (inferredIntent === "schedule") ||
        state.lastIntent === "schedule" ||
        hasConcreteTimeAnchor(userText) ||
        hasBookingIntent(userText)
    );


    const baseSummary = await buildOrReuseSummary({ empresaId, conversationId: chatId, kb });
    summaryText = overlayAgenda(baseSummary, newDraft);

    // === INFO BREAKER con seguimiento de agenda ===
    if (infoBreaker) {
        let texto = await runLLM({ summary: summaryText, userText, imageUrl }).catch(() => "");

        const wasGreeted = (await loadState(chatId)).greeted;
        texto = sanitizeGreeting(texto, { allowFirstGreeting: !wasGreeted });

        // Si estamos (o parecemos estar) en flujo de agenda y faltan piezas, pídelas al final
        // Política: si pidió agendar o ya hay slots parciales, pide SOLO 1 pieza faltante
        // DESPUÉS: solo pedimos piezas si hay clara intención de agendar
        const clsSoft = await classifyTurnLLM(userText);
        const wantBookSoft = hasBookingIntent(userText) || clsSoft.label === "book" || hasConcreteTimeAnchor(userText);

        if (wantBookSoft) {
            if (needProcedure || needWhen || needName) {
                const tail = buildAskPiecesText(kb, { proc: needProcedure, when: needWhen, name: needName });
                if (tail) texto = `${texto}\n\n${tail}`;
            }
            await patchState(chatId, { lastIntent: "schedule" });
        } else {

            texto = await appendOnceInvitationTail(chatId, texto, CTA_UNICO);

        }


        texto = stripEmojis(clampInfoText(texto));
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

    const wantBookSoft =
        hasBookingIntent(userText) ||
        clsForWhen.label === "book" ||
        hasConcreteTimeAnchor(userText);

    const shouldAskForAgendaPieces = !infoBreaker && wantBookSoft;


    if (shouldAskForAgendaPieces && (needProcedure || needWhen || needName)) {
        let texto = buildAskPiecesText(kb, { proc: needProcedure, when: needWhen, name: needName });
        texto = addEmojiStable(clampText(texto), chatId);

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

    const baseSummary2 = await buildOrReuseSummary({ empresaId, conversationId: chatId, kb });
    summaryText = overlayAgenda(baseSummary2, newDraft);
    let texto = await runLLM({ summary: summaryText, userText, imageUrl }).catch(() => "");

    const wasGreeted = (await loadState(chatId)).greeted;
    texto = sanitizeGreeting(texto, { allowFirstGreeting: !wasGreeted });

    // Invitación suave...
    if (inferredIntent === "info" && !hasServiceOrWhen) {
        texto = await appendOnceInvitationTail(chatId, texto, CTA_UNICO);
    }


    texto = stripEmojis(texto);  // ← NUEVO (sanea emojis del LLM)
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

import prisma from "../../../lib/prisma";
import type { Prisma, StaffRole } from "@prisma/client";
import { MessageFrom, ConversationEstado, MediaType } from "@prisma/client";
import { openai } from "../../../lib/openai";
import * as Wam from "../../../services/whatsapp.service";

import {
    loadEsteticaKB,
    resolveServiceName,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

const CONF = {
    MEM_TTL_MIN: 60,
    GRAN_MIN: 15,
    MAX_SLOTS: 6,
    DAYS_HORIZON: 14,
    MAX_HISTORY: 20,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.2,
    MODEL: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
};

// ——— Solo colecta (horarios referenciales; el equipo humano confirma)
const COLLECT_ONLY = true;

/* ==== Imagen (arrastre contextual) ==== */
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 300_000);

/* ==== Idempotencia (memoria de proceso) ==== */
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
const processedInbound = new Map<number, number>(); // messageId -> ts
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = recentReplies.get(conversationId);
    const clientMs = clientTs.getTime();
    if (prev && prev.afterMs >= clientMs && now - prev.repliedAtMs <= windowMs) return true;
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now });
    return false;
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    const now = Date.now();
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
}
function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

/* ===========================
   Helpers de agenda (DB)
   =========================== */
function pad2(n: number) {
    return String(n).padStart(2, "0");
}
function hhmmFrom(raw?: string | null) {
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    const hh = Math.min(23, Number(m[1] ?? 0));
    const mm = Math.min(59, Number(m[2] ?? 0));
    return `${pad2(hh)}:${pad2(mm)}`;
}
function weekdayToDow(day: any): number | null {
    const key = String(day || "").toUpperCase();
    const map: Record<string, number> = {
        SUNDAY: 0, SUNDAY_: 0, DOMINGO: 0,
        MONDAY: 1, LUNES: 1,
        TUESDAY: 2, MARTES: 2,
        WEDNESDAY: 3, MIERCOLES: 3, MIÉRCOLES: 3,
        THURSDAY: 4, JUEVES: 4,
        FRIDAY: 5, VIERNES: 5,
        SATURDAY: 6, SABADO: 6, SÁBADO: 6,
    };
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

// — Lectura de appointmentHour
async function fetchAppointmentHours(empresaId: number) {
    const rows = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: [{ day: "asc" }],
        select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    return rows;
}

// — Lectura de excepciones (robusto)
async function fetchAppointmentExceptions(empresaId: number, horizonDays = 35) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + horizonDays);
    try {
        const rows: any[] = await (prisma as any).appointment_exeption.findMany({
            where: { empresaId, date: { gte: now, lte: end } },
            orderBy: [{ date: "asc" }],
            select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
        });
        return rows;
    } catch {
        try {
            const rows: any[] = await (prisma as any).appointment_exception.findMany({
                where: { empresaId, date: { gte: now, lte: end } },
                orderBy: [{ date: "asc" }],
                select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
            });
            return rows;
        } catch {
            return [];
        }
    }
}

function normalizeHours(rows: any[]) {
    const byDow: Record<number, Array<{ start: string; end: string }>> = {};
    for (const r of rows || []) {
        if (!r) continue;
        if (r.isOpen === false) continue;
        const dow = weekdayToDow(r.day);
        if (dow == null) continue;
        const s1 = hhmmFrom(r.start1), e1 = hhmmFrom(r.end1);
        const s2 = hhmmFrom(r.start2), e2 = hhmmFrom(r.end2);
        if (s1 && e1) (byDow[dow] ||= []).push({ start: s1, end: e1 });
        if (s2 && e2) (byDow[dow] ||= []).push({ start: s2, end: e2 });
    }
    return byDow;
}
function normalizeExceptions(rows: any[]) {
    const items: Array<{ date: string; closed: boolean; motivo?: string }> = [];
    for (const r of rows || []) {
        const closed = (r.isOpen === false) || (r.closed === true) || (r.open === false);
        const date = r.dateISO ?? (r.date ? new Date(r.date).toISOString().slice(0, 10) : null);
        if (!date) continue;
        items.push({ date, closed, motivo: r.motivo ?? r.reason });
    }
    return items;
}

/* ===========================
   Draft utils
   =========================== */
type ConversationLite = { id: number; phone: string; estado: ConversationEstado; };

type DraftStage = "idle" | "offer" | "confirm";
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
        timeHHMM?: string; // hora exacta (opcional)
        timeNote?: string; // franja: mañana/tarde/noche
        durationMin?: number;
        stage?: DraftStage;
    };
    slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
    handoffLocked?: boolean; // congela cuando pasa a requiere_agente
};

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}
async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({ where: { conversationId }, select: { data: true } });
    const raw = (row?.data as any) || {};
    const data: AgentState = {
        greeted: !!raw.greeted,
        lastIntent: raw.lastIntent,
        lastServiceId: raw.lastServiceId ?? null,
        lastServiceName: raw.lastServiceName ?? null,
        draft: raw.draft ?? {},
        slotsCache: raw.slotsCache ?? undefined,
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

/* ===========================
   Historial y summary
   =========================== */
type ChatHistoryItem = { role: "user" | "assistant"; content: string };
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = CONF.MAX_HISTORY): Promise<ChatHistoryItem[]> {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take,
        select: { from: true, contenido: true },
    });
    return rows.reverse().map((r) => ({
        role: r.from === MessageFrom.client ? "user" : "assistant",
        content: softTrim(r.contenido || "", 280),
    })) as ChatHistoryItem[];
}

/* ===========================
   Manejo de imagen
   =========================== */
function mentionsImageExplicitly(t: string) {
    const s = String(t || "").toLowerCase();
    return (
        /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
        /(mira|revisa|checa|ve|verifica)\s+la\s+(foto|imagen)/.test(s) ||
        /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
        /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
    );
}
async function pickImageForContext(opts: {
    conversationId: number;
    directUrl?: string | null;
    userText: string;
    caption: string;
    referenceTs: Date;
}): Promise<{ url: string | null; noteToAppend: string }> {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts;
    if (directUrl) {
        return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "" };
    }
    if (!userText) return { url: null, noteToAppend: "" };

    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        return { url: String(veryRecent.mediaUrl), noteToAppend: veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "" };
    }

    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
            },
            orderBy: { timestamp: "desc" },
            select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            return { url: String(referenced.mediaUrl), noteToAppend: referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "" };
        }
    }
    return { url: null, noteToAppend: "" };
}

/* ===========================
   Summary (con horarios DB)
   =========================== */
async function buildOrReuseSummary(args: {
    empresaId: number;
    conversationId: number;
    kb: EsteticaKB;
    history: ChatHistoryItem[];
}): Promise<string> {
    const { empresaId, conversationId, kb, history } = args;

    const cached = await loadState(conversationId);
    const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
    if (fresh) return cached.summary!.text;

    const [hoursRows, exceptionsRows] = await Promise.all([
        fetchAppointmentHours(empresaId),
        COLLECT_ONLY ? Promise.resolve([]) : fetchAppointmentExceptions(empresaId, 35),
    ]);

    const { human: hoursLine } = await buildBusinessRangesHuman(empresaId, kb, { rows: hoursRows });

    let exceptionsLine = "";
    if (!COLLECT_ONLY) {
        const exceptions = normalizeExceptions(exceptionsRows);
        const closedSoon = exceptions.filter(e => e.closed).slice(0, 6).map(e => e.date).join(", ");
        if (closedSoon) exceptionsLine = `Excepciones agenda (DB): ${closedSoon} (cerrado)`;
    }

    const services = (kb.procedures ?? [])
        .filter((s) => s.enabled !== false)
        .map((s) => (s.priceMin ? `${s.name} (Desde ${formatCOP(s.priceMin)} COP)` : s.name))
        .join(" • ");

    const staffByRole: Record<StaffRole, string[]> = { esteticista: [], medico: [], profesional: [] } as any;
    (kb.staff || []).forEach((s) => { if (s.active) (staffByRole[s.role] ||= []).push(s.name); });

    const rules: string[] = [];
    if (kb.bufferMin) rules.push(`Buffer ${kb.bufferMin} min`);
    if (kb.defaultServiceDurationMin) rules.push(`Duración por defecto ${kb.defaultServiceDurationMin} min`);

    const logistics: string[] = [];
    if (kb.location?.name) logistics.push(`Sede: ${kb.location.name}`);
    if (kb.location?.address) logistics.push(`Dirección: ${kb.location.address}`);

    const base = [
        kb.businessName ? `Negocio: ${kb.businessName}` : "Negocio: Clínica estética",
        `TZ: ${kb.timezone}`,
        logistics.length ? logistics.join(" | ") : "",
        rules.length ? rules.join(" | ") : "",
        services ? `Servicios: ${services}` : "",
        Object.entries(staffByRole).some(([_, arr]) => (arr?.length ?? 0) > 0)
            ? `Staff: ${[
                staffByRole.medico?.length ? `Médicos: ${staffByRole.medico.join(", ")}` : "",
                staffByRole.esteticista?.length ? `Esteticistas: ${staffByRole.esteticista.join(", ")}` : "",
                staffByRole.profesional?.length ? `Profesionales: ${staffByRole.profesional.join(", ")}` : "",
            ].filter(Boolean).join(" | ")}`
            : "",
        hoursLine ? `Horario base (DB): ${hoursLine}` : "",
        exceptionsLine,
        kb.exceptions?.length
            ? `Excepciones próximas (KB): ${kb.exceptions.slice(0, 2).map((e) => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`).join(", ")}`
            : "",
        `Historial breve: ${history.slice(-6).map((h) => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 100)).join(" | ")}`,
    ].filter(Boolean).join("\n");

    let compact = base;
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL,
                    temperature: 0.1,
                    max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) },
                    ],
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL,
                    temperature: 0.1,
                    max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) },
                    ],
                });
        compact = (resp?.choices?.[0]?.message?.content || base).trim().replace(/\n{3,}/g, "\n\n");
    } catch { /* fallback base */ }

    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    return compact;
}

/* ===========================
   Intención / tono
   =========================== */
function detectIntent(text: string): "price" | "schedule" | "reschedule" | "cancel" | "info" | "other" {
    const t = (text || "").toLowerCase();
    if (/\b(precio|costo|valor|tarifa|cu[aá]nto)\b/.test(t)) return "price";
    if (/\b(horario|horarios|disponibilidad|cupo|agenda[rs]?|agendar|programar|reservar)\b/.test(t)) return "schedule";
    if (/\b(reagendar|cambiar|mover|otra hora|reprogramar)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";
    if (/\b(beneficios?|indicaciones|cuidados|contraindicaciones|en qu[eé] consiste|como funciona)\b/.test(t)) return "info";
    return "other";
}
function detectExactPriceQuery(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(precio\s+exacto|exacto\s+seg[uú]n\s+mi\s+caso|precio\s+final)\b/.test(t);
}
function varyPrefix(kind: "offer" | "ask" | "ok"): string {
    const sets = {
        offer: ["Te cuento rápido:", "Resumen:", "Puntos clave:"],
        ask: ["¿Te paso opciones…?", "¿Seguimos con…?", "¿Quieres ver horarios?"],
        ok: ["Perfecto ✅", "¡Listo! ✨", "Genial 🙌"],
    } as const;
    const arr = sets[kind];
    return arr[Math.floor(Math.random() * arr.length)];
}

/* ===========================
   Sinónimos y staff
   =========================== */
function pickStaffForProcedure(kb: EsteticaKB, proc?: EsteticaKB["procedures"][number] | null) {
    const active = (kb.staff || []).filter((s) => s.active);
    if (!active.length) return null;
    if (proc?.requiredStaffIds?.length) {
        const byId = active.find((s) => proc.requiredStaffIds!.includes(s.id));
        if (byId) return byId;
    }
    if (proc?.requiresAssessment) {
        const medico = active.find((s) => s.role === "medico");
        if (medico) return medico;
    }
    const esteticista = active.find((s) => s.role === "esteticista");
    if (esteticista) return esteticista;
    return active[0];
}
function resolveBySynonyms(kb: EsteticaKB, text: string) {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (/\bbotox|botox\b/.test(t) || /\btoxina\b/.test(t)) {
        const tox = kb.procedures.find((p) => /toxina\s*botul/i.test(p.name));
        if (tox) return tox;
    }
    if (/\blimpieza\b/.test(t)) {
        const limp = kb.procedures.find((p) => /limpieza/i.test(p.name));
        if (limp) return limp;
    }
    if (/\bpeeling\b/.test(t)) {
        const pe = kb.procedures.find((p) => /peeling/i.test(p.name));
        if (pe) return pe;
    }
    return null;
}

/* ===========================
   Utils de formato
   =========================== */
function softTrim(s: string | null | undefined, max = 240) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function endsWithPunctuation(t: string) {
    return /[.!?…]\s*$/.test((t || "").trim());
}
function closeNicely(raw: string): string {
    let t = (raw || "").trim();
    if (!t) return t;
    if (endsWithPunctuation(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    return t ? `${t}…` : raw.trim();
}
function clampLines(text: string, maxLines = CONF.REPLY_MAX_LINES) {
    const lines = (text || "").split("\n").filter(Boolean);
    if (lines.length <= maxLines) return text;
    const t = lines.slice(0, maxLines).join("\n").trim();
    return /[.!?…]$/.test(t) ? t : `${t}…`;
}
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}
// === Auto-handoff detector (por texto)
function shouldTriggerHandoff(text: string): boolean {
    const t = (text || "").toLowerCase();
    return /\b(verificar|revisar(?:á|a)?)\s+la\s+disponibilidad\b/.test(t)
        || /\bte\s+confirmo\b/.test(t)
        || /\bnuestro\s+equipo\s+te\s+confirm(a|ará)\b/.test(t);
}


/* ===========================
   Saludo + horarios humanos (DB, SOLO informativo)
   =========================== */
async function maybePrependGreeting(opts: { conversationId: number; kbName?: string | null; text: string; state: AgentState; })
    : Promise<{ text: string; greetedNow: boolean }> {
    const { conversationId, kbName, text, state } = opts;
    const startsWithGreeting = /^\s*(?:¡?\s*hola|buen[oa]s)\b/i.test(text);
    if (state.greeted || startsWithGreeting) return { text, greetedNow: false };

    const botPrev = await prisma.message.findFirst({ where: { conversationId, from: MessageFrom.bot }, select: { id: true } });
    if (botPrev) return { text, greetedNow: false };

    const hi = kbName ? `¡Hola! Bienvenido(a) a ${kbName}. ` : "¡Hola! ";
    return { text: `${hi}${text}`, greetedNow: true };
}

async function buildBusinessRangesHuman(
    empresaId: number,
    kb: EsteticaKB,
    opts?: { defaultDurMin?: number; rows?: any[] }
): Promise<{ human: string; lastStart?: string }> {
    const rows = opts?.rows ?? await fetchAppointmentHours(empresaId);
    const byDow = normalizeHours(rows);
    const dayShort = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

    const parts: string[] = [];
    for (let d = 0; d < 7; d++) {
        const ranges = byDow[d];
        if (ranges?.length) parts.push(`${dayShort[d]} ${ranges.map(r => `${r.start}–${r.end}`).join(", ")}`);
    }
    // si no hay horas en BD, devolvemos vacío (no inventamos texto “referencial”)
    const human = parts.join("; ");

    // última hora de *inicio* referencial (si hay horas), útil para copy
    const dur = Math.max(30, opts?.defaultDurMin ?? (kb.defaultServiceDurationMin ?? 60));
    const weekdays = [1, 2, 3, 4, 5];
    const endsWeekdays: string[] = [];
    const endsAll: string[] = [];

    for (const d of weekdays) for (const r of (byDow[d] || [])) if (r.end) endsWeekdays.push(r.end);
    for (let d = 0; d < 7; d++) for (const r of (byDow[d] || [])) if (r.end) endsAll.push(r.end);
    const pool = endsWeekdays.length ? endsWeekdays : endsAll;
    if (!pool.length) return { human, lastStart: undefined };

    const maxEnd = pool.sort()[pool.length - 1];
    const [eh, em] = maxEnd.split(":").map(Number);
    const startMins = eh * 60 + em - dur;
    const sh = Math.max(0, Math.floor(startMins / 60));
    const sm = Math.max(0, startMins % 60);
    const lastStart = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;

    return { human, lastStart };
}


/* ===========================
   Persistencia + WhatsApp
   =========================== */
async function persistBotReply(opts: {
    conversationId: number;
    empresaId: number;
    texto: string;
    nuevoEstado: ConversationEstado;
    to?: string;
    phoneNumberId?: string;
}) {
    const { conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId } = opts;

    const prevBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { timestamp: "desc" },
        select: { id: true, contenido: true, timestamp: true, externalId: true },
    });
    if (prevBot) {
        const sameText = (prevBot.contenido || "").trim() === (texto || "").trim();
        const recent = Date.now() - new Date(prevBot.timestamp as any).getTime() <= 15_000;
        if (sameText && recent) {
            await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
            return { messageId: prevBot.id, texto: prevBot.contenido, wamid: prevBot.externalId as any };
        }
    }

    const msg = await prisma.message.create({ data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId } });
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            const resp = await (Wam as any).sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
        } catch (e) {
            console.error("[ESTETICA] WA send error:", (e as any)?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* ===========================
   Detector + extractores
   =========================== */
function detectScheduleAsk(t: string): boolean {
    const s = (t || "").toLowerCase();
    return /\b(agendar|reservar|programar|cita|agenda|horarios|disponibilidad)\b/.test(s);
}
function extractPhone(raw: string): string | null {
    const t = String(raw || "");
    const m = t.match(/(?:\+?57)?\D?(\d{9,13})/);
    if (!m) return null;
    const clean = normalizeToE164(m[0]);
    return clean.length >= 10 && clean.length <= 13 ? clean : null;
}
function extractName(raw: string): string | null {
    const t = (raw || "").trim();
    let m =
        t.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ\s]{2,50})/i) ||
        t.match(/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})\b.*(cel|tel|whatsapp)/i);
    if (m && m[1]) return m[1].trim().replace(/\s+/g, " ");
    const onlyLetters = /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2}$/;
    if (onlyLetters.test(t) && t.length >= 3 && t.length <= 60) return t.replace(/\s+/g, " ");
    return null;
}
function extractWhen(raw: string): { label?: string; iso?: string } | null {
    const t = (raw || "").toLowerCase();
    const now = new Date();
    if (/\b(hoy)\b/.test(t)) return { label: "hoy", iso: now.toISOString() };
    if (/\b(mañana|manana)\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return { label: "mañana", iso: d.toISOString() }; }
    const wdMap: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
    const key = Object.keys(wdMap).find(k => t.includes(k));
    if (key) {
        const target = wdMap[key];
        const d = new Date(now);
        let daysAhead = (target - d.getDay() + 7) % 7;
        if (daysAhead === 0) daysAhead = 7;
        d.setDate(d.getDate() + daysAhead);
        return { label: key, iso: d.toISOString() };
    }
    const m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+a\s+las\s+(\d{1,2})(?::(\d{2}))?)?\b/);
    if (m) {
        const [, dd, mm, yyyyOpt, hhOpt, miOpt] = m;
        const yyyy = yyyyOpt ? Number(yyyyOpt.length === 2 ? "20" + yyyyOpt : yyyyOpt) : now.getFullYear();
        const d = new Date(yyyy, Number(mm) - 1, Number(dd), hhOpt ? Number(hhOpt) : 9, miOpt ? Number(miOpt) : 0, 0);
        return { label: "fecha indicada", iso: d.toISOString() };
    }
    return null;
}
function extractDayPeriod(raw: string): string | null {
    const t = (raw || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (/\b(ma[nñ]ana|por la ma[nñ]ana|en la ma[nñ]ana)\b/.test(t)) return "mañana";
    if (/\b(tarde|por la tarde|en la tarde)\b/.test(t)) return "tarde";
    if (/\b(noche|por la noche|en la noche)\b/.test(t)) return "noche";
    if (/\b(mediodia|medio dia)\b/.test(t)) return "mediodía";
    return null;
}
function extractHour(raw: string): string | null {
    const t = (raw || "").toLowerCase().replace(/\s+/g, " ").trim();
    let m = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/);
    if (m) {
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const suf = (m[3] || "").replace(/\./g, "");
        if (suf === "pm" && hh < 12) hh += 12;
        if (suf === "am" && hh === 12) hh = 0;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    m = t.match(/\b(?:a\s+las?\s+)?(\d{1,2})(?:\s*(a\.?m\.?|p\.?m\.?|am|pm))?\b/);
    if (m) {
        let hh = parseInt(m[1], 10);
        const suf = (m[2] || "").replace(/\./g, "");
        if (suf === "pm" && hh < 12) hh += 12;
        if (suf === "am" && hh === 12) hh = 0;
        if (hh >= 0 && hh <= 23) return `${String(hh).padStart(2, "0")}:00`;
    }
    return null;
}
function fmtHourLabel(hhmm?: string): string | null {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    const suf = h >= 12 ? "p. m." : "a. m.";
    const hr12 = h % 12 === 0 ? 12 : h % 12;
    return `${hr12}:${String(m).padStart(2, "0")} ${suf}`;
}
function missingFieldsForSchedule(d: AgentState["draft"] | undefined) {
    const faltan: Array<"name" | "phone" | "procedure"> = [];
    if (!d?.name) faltan.push("name");
    if (!d?.phone) faltan.push("phone");
    if (!(d?.procedureId || d?.procedureName)) faltan.push("procedure");
    return faltan;
}
function friendlyAskForMissing(faltan: ReturnType<typeof missingFieldsForSchedule>) {
    const asks: string[] = [];
    if (faltan.includes("name")) asks.push("¿Cuál es tu *nombre*?");
    if (faltan.includes("phone")) asks.push("¿Me confirmas tu *número de contacto* (WhatsApp)?");
    if (faltan.includes("procedure")) asks.push("¿Para qué *tratamiento* deseas la cita?");
    if (asks.length === 1) return asks[0];
    if (asks.length === 2) return `${asks[0]} ${asks[1]}`;
    return `Para agendar, necesito tres datos: *nombre*, *número de contacto* y *tratamiento*. ${asks.join(" ")}`;
}
async function tagAsSchedulingNeeded(opts: { conversationId: number; empresaId: number; label?: string }) {
    const { conversationId } = opts;
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: ConversationEstado.requiere_agente } });
    await patchState(conversationId, { handoffLocked: true });
}

/* ===========================
   Núcleo
   =========================== */
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
    const { chatId, conversationId: conversationIdArg, empresaId, toPhone, phoneNumberId } = args;
    let contenido = (args.contenido || "").trim();

    const conversationId = conversationIdArg ?? chatId;
    if (!conversationId) return { estado: "pendiente", mensaje: "" };

    const conversacion = (await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, phone: true, estado: true },
    })) as ConversationLite | null;
    if (!conversacion) return { estado: "pendiente", mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true, contenido: true, mediaType: true, caption: true, mediaUrl: true },
    });

    // — Guard: si ya está en handoff, no responder
    let statePre = await loadState(conversationId);
    if (conversacion?.estado === ConversationEstado.requiere_agente || statePre.handoffLocked) {
        return { estado: "pendiente", mensaje: "" };
    }

    // Idempotencia de entrada
    if (last?.id && seenInboundRecently(last.id)) return { estado: "pendiente", mensaje: "" };
    if (last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
        return { estado: "pendiente", mensaje: "" };
    }

    // Fallback de contenido si viene vacío / solo imagen
    if (!contenido) {
        if (last?.contenido && last.contenido.trim()) contenido = last.contenido.trim();
        else if (last?.mediaType === MediaType.image && last?.caption) contenido = String(last.caption).trim();
        else contenido = "…";
    }

    // —— Imagen del último inbound
    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();
    if (isImage && !caption && (!contenido || contenido === "…")) {
        await new Promise((r) => setTimeout(r, IMAGE_WAIT_MS));
        return { estado: "pendiente", mensaje: "" };
    }
    if (isImage && last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
        return { estado: "pendiente", mensaje: "" };
    }

    // KB
    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) {
        const txt = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
        const saved = await persistBotReply({
            conversationId, empresaId, texto: txt, nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // Estado + Historial + Summary
    let state = await loadState(conversationId);
    const history = await getRecentHistory(conversationId, undefined, CONF.MAX_HISTORY);
    const compactContext = await buildOrReuseSummary({ empresaId, conversationId, kb, history });
    state = await loadState(conversationId);

    // Servicio + Intención
    let match = resolveServiceName(kb, contenido || "");
    if (!match.procedure) {
        const extra = resolveBySynonyms(kb, contenido || "");
        if (extra) match = { procedure: extra, matched: extra.name };
    }
    const service = match.procedure ?? (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) ?? null : null);
    let intent = detectIntent(contenido);
    if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

    // Reagendar / Cancelar -> Handoff inmediato
    if (intent === "reschedule" || intent === "cancel") {
        const texto = intent === "cancel"
            ? "Entiendo, te ayudo con la cancelación 🗓️. Dame un momento, reviso tu cita y te confirmo por aquí."
            : "Claro, te ayudo a reprogramarla 🗓️. Dame un momento, reviso tu cita y te propongo opciones por aquí.";
        await tagAsSchedulingNeeded({ conversationId, empresaId });
        const saved = await persistBotReply({
            conversationId, empresaId, texto, nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Interés en agendar (día → hora/franja → nombre → handoff) ===== */
    const wantsSchedule = detectScheduleAsk(contenido) || intent === "schedule";
    if (wantsSchedule) {
        const prev = state.draft ?? {};
        const whenAsk = extractWhen(contenido);
        const nameInText = extractName(contenido);
        const hourExact = extractHour(contenido);
        const hourPeriod = extractDayPeriod(contenido);

        const draft = {
            ...prev,
            whenISO: prev.whenISO || whenAsk?.iso || undefined,
            timeHHMM: prev.timeHHMM || hourExact || undefined,
            timeNote: prev.timeNote || hourPeriod || undefined,
            name: prev.name || nameInText || undefined,
            procedureId: prev.procedureId || (service?.id ?? undefined),
            procedureName: prev.procedureName || (service?.name ?? undefined),
        };

        // 1) Pedir día
        if (!draft.whenISO) {
            const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
            const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
            const textoBase = COLLECT_ONLY
                ? `¿Tienes *algún día* en mente para tu cita?${human ? ` Trabajamos: ${human}${sufijoUltima}.` : ""} Yo recojo tu preferencia y nuestro equipo confirma por aquí.`
                : `¿Tienes *algún día* en mente para tu cita?${human ? ` Trabajamos: ${human}.` : ""} Para este caso la *última cita* es a las ${lastStart ?? "…"}.`;


            let greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: textoBase, state });
            if (greet.greetedNow) await patchState(conversationId, { greeted: true });

            await patchState(conversationId, { lastIntent: "schedule", draft });
            const saved = await persistBotReply({
                conversationId, empresaId, texto: clampLines(closeNicely(greet.text)),
                nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        // 1.5) Con día, pedir hora si falta (hora o franja)
        if (!draft.timeHHMM && !draft.timeNote) {
            const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
            const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
            const askHour = COLLECT_ONLY
                ? `Genial. Para ese día, ¿qué *hora* te queda mejor? (Ej.: 10:30 am, 3 pm) o dame una *franja* como "mañana"/"tarde".${human ? ` Trabajamos: ${human}${sufijoUltima}.` : ""} Yo solo recojo la preferencia y el equipo confirma.`
                : `Genial. Para ese día, ¿qué *hora* te queda mejor? (Ej.: 10:30 am, 3 pm). También puedo tomar "mañana"/"tarde".${human ? ` Trabajamos: ${human};` : ""} última cita ${lastStart ?? "…"}.`;


            let greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: askHour, state });
            if (greet.greetedNow) await patchState(conversationId, { greeted: true });

            await patchState(conversationId, { lastIntent: "schedule", draft });
            const saved = await persistBotReply({
                conversationId, empresaId, texto: clampLines(closeNicely(greet.text)),
                nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        // 2) Con día y hora/franja, pedir nombre
        if (!draft.name) {
            const askName = "Perfecto 👌 ¿Me regalas tu *nombre completo* para reservar?";
            let greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: askName, state });
            if (greet.greetedNow) await patchState(conversationId, { greeted: true });

            await patchState(conversationId, { lastIntent: "schedule", draft });
            const saved = await persistBotReply({
                conversationId, empresaId, texto: clampLines(closeNicely(greet.text)),
                nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        // 3) Día + (hora o franja) + nombre → handoff inmediato (mensaje solicitado)
        // 3) Día + (hora o franja) + nombre → handoff inmediato (mensaje solicitado)
        await patchState(conversationId, { lastIntent: "schedule", draft });

        const preferencia =
            draft.timeHHMM
                ? `${new Date(draft.whenISO!).toLocaleDateString("es-CO")} · ${fmtHourLabel(draft.timeHHMM)}`
                : draft.timeNote
                    ? `${new Date(draft.whenISO!).toLocaleDateString("es-CO")} · ${draft.timeNote}`
                    : "recibida";

        const piezas: string[] = [];
        if (draft.procedureName) piezas.push(`Tratamiento: *${draft.procedureName}*`);
        piezas.push(`Nombre: *${draft.name}*`);
        piezas.push(`Preferencia: *${preferencia}*`);

        const reply =
            `Perfecto, dame *unos minutos* ⏳ voy a *verificar la disponibilidad* de ese horario y te *confirmo por aquí*.\n${piezas.join(" · ")}`;

        // 1) Marcar handoff y congelar el flujo
        await tagAsSchedulingNeeded({ conversationId, empresaId });

        // 2) Persistir SIEMPRE como requiere_agente (no condicionarlo)
        const saved = await persistBotReply({
            conversationId,
            empresaId,
            texto: clampLines(closeNicely(reply)),
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });

        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);

        return {
            estado: "requiere_agente",
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };


    }

    /* ===== UBICACIÓN ===== */
    const isLocation = /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde\s+est[áa]n|mapa|c[oó]mo\s+llego|como\s+llego|sede|ubicados?)\b/i.test(contenido);
    if (isLocation) {
        const loc = (kb.location ?? {}) as any;
        const lines: string[] = [];
        if (loc.name) lines.push(`Estamos en nuestra sede *${String(loc.name)}*.`);
        const addrParts = [loc.address, loc.address2, loc.reference].filter(Boolean).map((s: unknown) => String(s).trim());
        if (addrParts.length) lines.push(addrParts.join(", "));
        if (loc.mapsUrl) lines.push(`Mapa: ${String(loc.mapsUrl)}`);
        const arrival = loc.arrivalInstructions ?? loc.instructions;
        if (loc.parkingInfo) lines.push(`Parqueadero: ${String(loc.parkingInfo)}`);
        if (arrival) lines.push(`Indicaciones: ${String(arrival)}`);

        let texto = lines.length ? lines.join("\n") : "Estamos ubicados en nuestra sede principal. 😊";
        const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
        texto = greet.text;
        if (greet.greetedNow) await patchState(conversationId, { greeted: true });

        await patchState(conversationId, { lastIntent: "info" });
        const saved = await persistBotReply({
            conversationId, empresaId, texto: clampLines(closeNicely(texto)),
            nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Quién realiza ===== */
    if (/\b(qu[ié]n|quien|persona|profesional|doctor|doctora|m[eé]dico|esteticista).*(hace|realiza|atiende|me va a hacer)\b/i.test(contenido)) {
        const whoProc = service || (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) : null);
        const staff = pickStaffForProcedure(kb, whoProc || undefined);
        const labelSvc = whoProc?.name ? `*${whoProc.name}* ` : "";
        let texto = staff
            ? `${labelSvc}lo realiza ${staff.role === "medico" ? "la/el Dr(a)." : ""} *${staff.name}*. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Quieres ver horarios?`
            : `${labelSvc}lo realiza un profesional de nuestro equipo. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Te paso horarios?`;

        const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
        texto = greet.text;
        if (greet.greetedNow) await patchState(conversationId, { greeted: true });

        await patchState(conversationId, {
            lastIntent: "info",
            ...(whoProc ? { lastServiceId: whoProc.id, lastServiceName: whoProc.name } : {}),
        });
        const saved = await persistBotReply({
            conversationId, empresaId, texto: clampLines(closeNicely(texto)),
            nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== ¿Qué servicios ofrecen? ===== */
    if (/que\s+servicios|qué\s+servicios|servicios\s+ofreces?/i.test(contenido)) {
        const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
        const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
        const items = kb.procedures.slice(0, 6).map((p) => {
            const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
            return `• ${p.name}${desde}`;
        }).join("\n");

        let texto = clampLines(closeNicely(
            `${items}\n\nSi alguno te interesa, dime el *día y hora* que prefieres agendar${human ? ` (trabajamos: ${human}${sufijoUltima})` : ""}.`

        ));
        const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
        texto = greet.text;
        if (greet.greetedNow) await patchState(conversationId, { greeted: true });

        await patchState(conversationId, { lastIntent: "schedule" });
        const saved = await persistBotReply({
            conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== “Precio exacto según mi caso” ===== */
    if (detectExactPriceQuery(contenido)) {
        const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
        const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
        let texto = `El *precio exacto* se confirma en la *valoración presencial* antes del procedimiento. 💡 Si te parece, dime el *día y hora* que prefieres (trabajamos: ${human}${sufijoUltima}) y luego tu *nombre completo* para reservar.`;
        const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
        texto = greet.text;
        if (greet.greetedNow) await patchState(conversationId, { greeted: true });

        await patchState(conversationId, { lastIntent: "schedule" });
        const saved = await persistBotReply({
            conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Precio – catálogo (DESDE) ===== */
    if (detectIntent(contenido) === "price") {
        if (service) {
            const priceLabel = service.priceMin ? `Desde ${formatCOP(service.priceMin)} (COP)` : null;
            const dur = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;
            const staff = pickStaffForProcedure(kb, service);
            const piezas = [
                `${varyPrefix("offer")} *${service.name}*`,
                priceLabel ? `💵 ${priceLabel}` : "",
                `⏱️ Aprox. ${dur} min`,
                staff ? `👩‍⚕️ Profesional: ${staff.name}` : "",
            ].filter(Boolean);
            let texto = clampLines(closeNicely(`${piezas.join(" · ")}\n\n${varyPrefix("ask")} ¿quieres ver horarios cercanos? 🗓️`));

            const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
            texto = greet.text;
            if (greet.greetedNow) await patchState(conversationId, { greeted: true });

            await patchState(conversationId, { lastIntent: "price", lastServiceId: service.id, lastServiceName: service.name });
            const saved = await persistBotReply({
                conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } else {
            const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
            const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
            const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
            let ask = `Manejo los *precios de catálogo* (valores “desde”). ¿De cuál tratamiento te paso precio? (Ej.: ${nombres}). Si ya sabes cuál, dime también el *día y hora* que prefieres (trabajamos: ${human}${sufijoUltima}).`;

            const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: ask, state });
            ask = greet.text;
            if (greet.greetedNow) await patchState(conversationId, { greeted: true });

            await patchState(conversationId, { lastIntent: "price" });
            const saved = await persistBotReply({
                conversationId, empresaId, texto: ask, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    // — Cortafuegos antes de respuesta libre
    {
        const conversacionNow = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { estado: true } });
        const stateNow = await loadState(conversationId);
        if (conversacionNow?.estado === ConversationEstado.requiere_agente || stateNow.handoffLocked) {
            return { estado: "pendiente", mensaje: "" };
        }
    }

    /* ===== Respuesta libre con contexto ===== */
    const system = [
        `Eres asesor de una clínica estética (${kb.timezone}).`,
        `Usa EXCLUSIVAMENTE la información del siguiente "Resumen operativo".`,
        `Precios: toma SOLO los valores “desde” del catálogo (priceMin). NO confirmes precios exactos ni personalices costos por chat.`,
        `Si el usuario pide precio exacto, aclara que se confirma en *valoración presencial* e invita a elegir *día y hora* y a compartir su *nombre completo* para agendar.`,
        `No inventes promociones, ni confirmes citas, ni ofrezcas horarios específicos.`,
        `En esta fase NO confirmes ni niegues disponibilidad ni digas que algún día está cerrado. Si preguntan por horarios, responde en términos generales, pide *día/hora o franja* y *nombre*, y aclara que el equipo humano confirma.`,
        `En el primer mensaje puedes saludar brevemente; después NO repitas saludos.`,
        `Responde directo, breve (2–5 líneas, 0–2 emojis).`,
        `Resumen operativo (OBLIGATORIO LEER Y RESPETAR):\n${compactContext}`,
    ].join("\n");

    const userCtx = [
        service ? `Servicio en contexto: ${service.name}` : state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : "",
        `Usuario: ${contenido}`,
    ].filter(Boolean).join("\n");

    const dialogMsgs = history.slice(-6).map((h) => ({ role: h.role, content: h.content }));

    let effectiveImageUrl = imageUrl;
    let contenidoConNota = contenido;
    if (!effectiveImageUrl && contenido) {
        const picked = await pickImageForContext({
            conversationId, directUrl: null, userText: contenido, caption, referenceTs,
        });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) contenidoConNota = `${contenido}${picked.noteToAppend}`;
    }

    const messages: any[] = [{ role: "system", content: system }, ...dialogMsgs];
    if (effectiveImageUrl) {
        messages.push({
            role: "user",
            content: [
                { type: "text", text: [service ? `Servicio en contexto: ${service.name}` : state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : "", `Usuario: ${contenidoConNota}`].filter(Boolean).join("\n") },
                { type: "image_url", image_url: { url: effectiveImageUrl } },
            ],
        });
    } else {
        messages.push({ role: "user", content: userCtx });
    }

    let texto = "";
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({ model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190, messages })
                : await (openai as any).createChatCompletion({ model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190, messages });
        texto = (resp?.choices?.[0]?.message?.content || "").trim();
    } catch {
        texto = "Puedo ayudarte con tratamientos faciales (limpieza, peeling, toxina botulínica). ¿Sobre cuál quieres info?";
    }

    texto = clampLines(closeNicely(texto));
    const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
    texto = greet.text;
    if (greet.greetedNow) await patchState(conversationId, { greeted: true });

    await patchState(conversationId, {
        lastIntent: detectIntent(contenido) === "other" ? state.lastIntent : detectIntent(contenido),
        ...(service ? { lastServiceId: service.id, lastServiceName: service.name } : {}),
    });

    const saved = await persistBotReply({
        conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
    return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}

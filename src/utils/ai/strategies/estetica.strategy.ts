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
    MEM_TTL_MIN: 5,
    GRAN_MIN: 15,
    MAX_SLOTS: 6,     // compat
    DAYS_HORIZON: 14, // compat
    MAX_HISTORY: 12,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.5,
    MODEL: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
};

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
const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
function pad2(n: number) { return String(n).padStart(2, "0"); }
function hhmmFrom(raw?: string | null) {
    if (!raw) return null;
    // admite "HH:mm" ó "HHmm" ó "HH:mm:ss"
    const m = raw.match(/^(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    const hh = Math.min(23, Number(m[1] ?? 0));
    const mm = Math.min(59, Number(m[2] ?? 0));
    return `${pad2(hh)}:${pad2(mm)}`;
}

// Lectura robusta de appointmentHour (varios posibles nombres/columnas)
async function fetchAppointmentHours(empresaId: number) {
    try {
        const rows: any[] = await (prisma as any).appointmentHour.findMany({
            where: { empresaId },
            orderBy: [{ dow: "asc" as any }, { dayOfWeek: "asc" as any }, { start: "asc" as any }],
            select: { dow: true, dayOfWeek: true, start: true, startTime: true, end: true, endTime: true, active: true },
        });
        return rows;
    } catch {
        try {
            const rows: any[] = await (prisma as any).appointment_hours.findMany({
                where: { empresaId },
                orderBy: [{ dow: "asc" as any }, { dayOfWeek: "asc" as any }, { start: "asc" as any }],
                select: { dow: true, dayOfWeek: true, start: true, startTime: true, end: true, endTime: true, active: true },
            });
            return rows;
        } catch {
            return [];
        }
    }
}

// Lectura robusta de appointment_exeption / appointment_exception
async function fetchAppointmentExceptions(empresaId: number, horizonDays = 35) {
    const now = new Date();
    const end = new Date(now); end.setDate(end.getDate() + horizonDays);
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
    // agrupa por día de semana (0..6)
    const byDow: Record<number, Array<{ start: string; end: string }>> = {};
    for (const r of rows || []) {
        const active = r.active ?? true;
        if (!active) continue;
        const dow = (typeof r.dow === "number" ? r.dow : r.dayOfWeek) ?? null;
        if (dow == null) continue;
        const start = hhmmFrom(r.startTime ?? r.start);
        const end = hhmmFrom(r.endTime ?? r.end);
        if (!start || !end) continue;
        (byDow[dow] ||= []).push({ start, end });
    }
    return byDow;
}

function formatHoursLine(byDow: Record<number, Array<{ start: string; end: string }>>) {
    // ejemplo: "Lun-Vie 09:00–18:00; Sáb 09:00–13:00"
    const parts: string[] = [];
    for (let d = 0; d < 7; d++) {
        const ranges = byDow[d];
        if (!ranges || !ranges.length) continue;
        const label = DOW_LABELS[d];
        const joined = ranges.map(r => `${r.start}–${r.end}`).join(", ");
        parts.push(`${label} ${joined}`);
    }
    return parts.join("; ");
}

function normalizeExceptions(rows: any[]) {
    // devuelve fechas cerradas (isOpen=false || closed=true)
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
        durationMin?: number;
        stage?: DraftStage;
    };
    slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
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
        slotsCache: raw.slotsCache ?? undefined,
        summary: raw.summary ?? undefined,
        expireAt: raw.expireAt,
    };
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { greeted: data.greeted, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
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
async function getRecentHistory(
    conversationId: number,
    excludeMessageId?: number,
    take = CONF.MAX_HISTORY
): Promise<ChatHistoryItem[]> {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take,
        select: { from: true, contenido: true },
    });
    return rows
        .reverse()
        .map((r) => ({ role: r.from === MessageFrom.client ? "user" : "assistant", content: softTrim(r.contenido || "", 280) })) as ChatHistoryItem[];
}

/* ===========================
   Manejo de imagen (arrastre contextual)
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
        return {
            url: String(directUrl),
            noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "",
        };
    }
    if (!userText) return { url: null, noteToAppend: "" };

    // 1) Usa la imagen más reciente del usuario dentro de la ventana "carry"
    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: {
                gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS),
                lte: referenceTs,
            },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        return {
            url: String(veryRecent.mediaUrl),
            noteToAppend: veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "",
        };
    }

    // 2) Si el texto menciona explícitamente una imagen, busca más atrás (lookback)
    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: {
                    gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS),
                    lte: referenceTs,
                },
            },
            orderBy: { timestamp: "desc" },
            select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            return {
                url: String(referenced.mediaUrl),
                noteToAppend: referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "",
            };
        }
    }

    return { url: null, noteToAppend: "" };
}


// ⬇️ ACTUALIZADO: incluye horas base + excepciones (DB) y NO convierte TZ (usa tal cual viene de la BD)
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

    // DB hours + exceptions
    const [hoursRows, exceptionsRows] = await Promise.all([
        fetchAppointmentHours(empresaId),
        fetchAppointmentExceptions(empresaId, 35),
    ]);
    const byDow = normalizeHours(hoursRows);
    const hoursLine = formatHoursLine(byDow);
    const exceptions = normalizeExceptions(exceptionsRows);
    const closedSoon = exceptions.filter(e => e.closed).slice(0, 6).map(e => e.date).join(", ");

    const services = (kb.procedures ?? [])
        .filter((s) => s.enabled !== false)
        .map((s) => {
            const desde = s.priceMin ? formatCOP(s.priceMin) : null;
            return desde ? `${s.name} (Desde ${desde} COP)` : s.name;
        })
        .join(" • ");

    const staffByRole: Record<StaffRole, string[]> = { esteticista: [], medico: [], profesional: [] } as any;
    (kb.staff || []).forEach((s) => {
        if (s.active) (staffByRole[s.role] ||= []).push(s.name);
    });

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
            ]
                .filter(Boolean)
                .join(" | ")}`
            : "",
        hoursLine ? `Horario base (DB): ${hoursLine}` : "",
        closedSoon ? `Excepciones agenda (DB): ${closedSoon} (cerrado)` : "",
        kb.exceptions?.length
            ? `Excepciones próximas (KB): ${kb.exceptions.slice(0, 2).map((e) => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`).join(", ")}`
            : "",
        `Historial breve: ${history.slice(-6).map((h) => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 100)).join(" | ")}`,
    ]
        .filter(Boolean)
        .join("\n");

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
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(Number(value));
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

    // 🛡️ DEDUP DE SALIDA
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

    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
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
   Detector + extractores + tagging
   =========================== */
function detectScheduleAsk(t: string): boolean {
    const s = (t || "").toLowerCase();
    return /\b(agendar|reservar|programar|cita|agenda|horarios|disponibilidad)\b/.test(s);
}

// ✅ Mejora: busca secuencia de 9–13 dígitos y luego normaliza/valida
function extractPhone(raw: string): string | null {
    const t = String(raw || "");
    const m = t.match(/(?:\+?57)?\D?(\d{9,13})/);
    if (!m) return null;
    const clean = normalizeToE164(m[0]);
    return clean.length >= 10 && clean.length <= 13 ? clean : null;
}

function extractName(raw: string): string | null {
    const t = (raw || "").trim();
    const m =
        t.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ\s]{2,50})/i) ||
        t.match(/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})\b.*(cel|tel|whatsapp)/i);
    if (m && m[1]) return m[1].trim().replace(/\s+/g, " ");
    return null;
}

// ✅ Mejora: si el día indicado es hoy, rueda al próximo (misma semana +7)
function extractWhen(raw: string): { label?: string; iso?: string } | null {
    const t = (raw || "").toLowerCase();
    const now = new Date();
    if (/\b(hoy)\b/.test(t)) return { label: "hoy", iso: now.toISOString() };
    if (/\b(mañana|manana)\b/.test(t)) {
        const d = new Date(now); d.setDate(d.getDate() + 1);
        return { label: "mañana", iso: d.toISOString() };
    }
    const wdMap: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
    const key = Object.keys(wdMap).find(k => t.includes(k));
    if (key) {
        const target = wdMap[key];
        const d = new Date(now);
        let daysAhead = (target - d.getDay() + 7) % 7;
        if (daysAhead === 0) daysAhead = 7; // siempre el próximo
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
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: ConversationEstado.requiere_agente },
    });
    // Si manejas tags:
    // await prisma.conversationTag.create({ data: { conversationId, empresaId: opts.empresaId, value: opts.label ?? "AGENDAMIENTO_SOLICITADO" } });
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

    const conversacion = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, phone: true, estado: true },
    });
    if (!conversacion) return { estado: "pendiente", mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true, contenido: true, mediaType: true, caption: true, mediaUrl: true },
    });

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
            conversationId,
            empresaId,
            texto: txt,
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // Estado + Historial + Summary (➡ summary ahora incluye horas y excepciones de la BD)
    let state = await loadState(conversationId);
    const history = await getRecentHistory(conversationId, undefined, CONF.MAX_HISTORY);
    const compactContext = await buildOrReuseSummary({ empresaId, conversationId, kb, history });
    state = await loadState(conversationId); // refrescar summary si cambió

    // Servicio + Intención (con sinónimos)
    let match = resolveServiceName(kb, contenido || "");
    if (!match.procedure) {
        const extra = resolveBySynonyms(kb, contenido || "");
        if (extra) match = { procedure: extra, matched: extra.name };
    }
    const service =
        match.procedure ?? (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) ?? null : null);
    let intent = detectIntent(contenido);
    if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

    /* ===== Enfoque “detector + tag” (sin scheduler) ===== */
    const wantsSchedule = detectScheduleAsk(contenido) || intent === "schedule";
    if (wantsSchedule) {
        // 1) Extraer y mergear con lo que ya había en draft
        const phoneInText = extractPhone(contenido) || extractPhone(conversacion.phone || "") || normalizeToE164(conversacion.phone || "");
        const nameInText = extractName(contenido);
        const whenAsk = extractWhen(contenido);

        const draft = {
            ...(state.draft ?? {}),
            name: state.draft?.name || nameInText || undefined,
            phone: state.draft?.phone || phoneInText || undefined,
            whenISO: state.draft?.whenISO || whenAsk?.iso || undefined,
            procedureId: state.draft?.procedureId || (service?.id ?? undefined),
            procedureName: state.draft?.procedureName || (service?.name ?? undefined),
            stage: "confirm" as const,
        };

        // 2) Si faltan datos, NO etiquetes: pide solo lo que falta y deja el estado en_proceso
        const faltan = missingFieldsForSchedule(draft);
        if (faltan.length > 0) {
            await patchState(conversationId, { lastIntent: "schedule", draft });

            const ask = friendlyAskForMissing(faltan);
            const tip = `\n\n(Para agilizar, puedes enviarlos en un solo mensaje: "Soy [Nombre], mi número es [cel], y quiero [tratamiento]")`;
            const reply = clampLines(closeNicely(`${ask}${tip}`));

            const saved = await persistBotReply({
                conversationId,
                empresaId,
                texto: reply,
                nuevoEstado: ConversationEstado.en_proceso, // ← aún no pasa al panel de agente
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        // 3) Si ya están los 3 datos, ahora sí etiquetar y pasar al panel
        await patchState(conversationId, { lastIntent: "schedule", draft });

        await tagAsSchedulingNeeded({ conversationId, empresaId }); // pone ConversationEstado.requiere_agente

        const piezas: string[] = [];
        if (draft.procedureName) piezas.push(`Tratamiento: *${draft.procedureName}*`);
        if (draft.whenISO || whenAsk?.label) piezas.push(`Preferencia: ${whenAsk?.label ? whenAsk.label : "recibida"}`);
        if (draft.phone) piezas.push(`Contacto: ${draft.phone}`);

        const tail = piezas.length ? `\n${piezas.join(" · ")}` : "";
        const reply = clampLines(closeNicely(
            `Gracias 🗓️. Tomé tus datos y un asesor te confirmará la hora disponible muy pronto.${tail}`
        ));

        const saved = await persistBotReply({
            conversationId,
            empresaId,
            texto: reply,
            nuevoEstado: ConversationEstado.requiere_agente, // ← ahora sí aparece en el panel de agentes
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }


    /* ===== UBICACIÓN ===== */
    const isLocation =
        /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde\s+est[áa]n|mapa|c[oó]mo\s+llego|como\s+llego|sede|ubicados?)\b/i.test(contenido);

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

        // Saludo solo si NO hay bot previo y greeted=false
        if (!state.greeted) {
            const botPrev = await prisma.message.findFirst({
                where: { conversationId, from: MessageFrom.bot },
                select: { id: true },
            });
            if (!botPrev) {
                const hi = kb.businessName ? `¡Hola! Bienvenido(a) a ${kb.businessName}. ` : "¡Hola! ";
                texto = `${hi}${texto}`;
            }
            await patchState(conversationId, { greeted: true });
        }

        await patchState(conversationId, { lastIntent: "info" });
        const saved = await persistBotReply({
            conversationId,
            empresaId,
            texto: clampLines(closeNicely(texto)),
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Preguntas sobre “quién realiza” ===== */
    if (
        /\b(qu[ié]n|quien|persona|profesional|doctor|doctora|m[eé]dico|esteticista).*(hace|realiza|atiende|me va a hacer)\b/i.test(contenido)
    ) {
        const whoProc = service || (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) : null);
        const staff = pickStaffForProcedure(kb, whoProc || undefined);
        const labelSvc = whoProc?.name ? `*${whoProc.name}* ` : "";
        const texto = staff
            ? `${labelSvc}lo realiza ${staff.role === "medico" ? "la/el Dr(a)." : ""} *${staff.name}*. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Quieres ver horarios?`
            : `${labelSvc}lo realiza un profesional de nuestro equipo. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Te paso horarios?`;

        await patchState(conversationId, { lastIntent: "info", ...(whoProc ? { lastServiceId: whoProc.id, lastServiceName: whoProc.name } : {}) });
        const saved = await persistBotReply({
            conversationId,
            empresaId,
            texto: clampLines(closeNicely(texto)),
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== ¿Qué servicios ofrecen? ===== */
    if (/que\s+servicios|qué\s+servicios|servicios\s+ofreces?/i.test(contenido)) {
        const items = kb.procedures.slice(0, 6).map((p) => {
            const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
            return `• ${p.name}${desde}`;
        }).join("\n");
        const tail = `¿Te paso precios de alguno u horarios para agendar?`;
        let texto = clampLines(closeNicely(`${items}\n\n${tail}`));

        if (!state.greeted) {
            const botPrev = await prisma.message.findFirst({ where: { conversationId, from: MessageFrom.bot }, select: { id: true } });
            if (!botPrev) {
                const hi = kb.businessName ? `¡Hola! Bienvenido(a) a ${kb.businessName}. ` : "¡Hola! ";
                texto = `${hi}${texto}`;
            }
            await patchState(conversationId, { greeted: true });
        }

        await patchState(conversationId, { lastIntent: "info" });
        const saved = await persistBotReply({
            conversationId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Precio – SOLO catálogo ===== */
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

            if (!state.greeted) {
                const botPrev = await prisma.message.findFirst({ where: { conversationId, from: MessageFrom.bot }, select: { id: true } });
                if (!botPrev) {
                    const hi = kb.businessName ? `¡Hola! Bienvenido(a) a ${kb.businessName}. ` : "¡Hola! ";
                    texto = `${hi}${texto}`;
                }
                await patchState(conversationId, { greeted: true });
            }

            await patchState(conversationId, { lastIntent: "price", lastServiceId: service.id, lastServiceName: service.name });
            const saved = await persistBotReply({
                conversationId,
                empresaId,
                texto,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } else {
            const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
            let ask = `Solo manejo precios del catálogo. ¿De cuál tratamiento te paso precio? (Ej.: ${nombres})`;
            if (!state.greeted) {
                const botPrev = await prisma.message.findFirst({ where: { conversationId, from: MessageFrom.bot }, select: { id: true } });
                if (!botPrev) {
                    const hi = kb.businessName ? `¡Hola! Bienvenido(a) a ${kb.businessName}. ` : "¡Hola! ";
                    ask = `${hi}${ask}`;
                }
                await patchState(conversationId, { greeted: true });
            }
            await patchState(conversationId, { lastIntent: "price" });
            const saved = await persistBotReply({
                conversationId,
                empresaId,
                texto: ask,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    /* ===== Respuesta libre con contexto (guardrails + imagen) ===== */
    const system = [
        `Eres asesor de una clínica estética (${kb.timezone}).`,
        `**Si es el primer mensaje, saluda brevemente; luego NO repitas saludos.**`,
        `Responde directo, sin plantillas; 2–5 líneas, 0–2 emojis.`,
        `SOLO habla de servicios del catálogo (limpieza facial, peeling, toxina botulínica, etc.).`,
        `PROHIBIDO inventar precios, promociones o servicios. Usa únicamente los valores del catálogo (priceMin) y el formato: "Desde $X (COP)".`,
        `Si el usuario pide algo que NO está en el catálogo, indícalo y no lo agendes.`,
        `Si el usuario pide ubicación/dirección/mapa, responde SOLO con datos de ubicación.`,
        `Resumen operativo + catálogo (contexto):\n${compactContext}`,
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
            conversationId,
            directUrl: null,
            userText: contenido,
            caption,
            referenceTs,
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
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL,
                    temperature: CONF.TEMPERATURE,
                    max_tokens: 190,
                    messages,
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL,
                    temperature: CONF.TEMPERATURE,
                    max_tokens: 190,
                    messages,
                });
        texto = (resp?.choices?.[0]?.message?.content || "").trim();
    } catch {
        texto = "Puedo ayudarte con tratamientos faciales (limpieza, peeling, toxina botulínica). ¿Sobre cuál quieres info?";
    }

    texto = clampLines(closeNicely(texto));

    // Saludo solo si NO hay bot previo y greeted=false
    if (!state.greeted) {
        const botPrev = await prisma.message.findFirst({ where: { conversationId, from: MessageFrom.bot }, select: { id: true } });
        if (!botPrev) {
            const hi = kb.businessName ? `¡Hola! Bienvenido(a) a ${kb.businessName}. ` : "¡Hola! ";
            texto = `${hi}${texto}`;
        }
        await patchState(conversationId, { greeted: true });
    }

    await patchState(conversationId, {
        lastIntent: detectIntent(contenido) === "other" ? state.lastIntent : detectIntent(contenido),
        ...(service ? { lastServiceId: service.id, lastServiceName: service.name } : {}),
    });

    const saved = await persistBotReply({
        conversationId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    });
    if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
    return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}

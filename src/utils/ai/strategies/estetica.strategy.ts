// utils/ai/strategies/estetica.strategy.ts
/**
 * Estética – Strategy con envío/recepción WhatsApp alineado a agent.strategy
 * - Acepta chatId o conversationId (hotfix id undefined)
 * - Persistencia + envío centralizado (persistBotReply → Wam.sendWhatsappMessage)
 * - Idempotencia/debounce como agent.strategy
 * - Summary/estado en conversation_state (TTL 5 min)
 * - Integra estetica.kb y estetica.schedule
 */

import prisma from "../../../lib/prisma";
import type { Prisma, AppointmentVertical } from "@prisma/client";
import { MessageFrom, ConversationEstado } from "@prisma/client";
import { openai } from "../../../lib/openai";
import * as Wam from "../../../services/whatsapp.service";

import {
    loadEsteticaKB,
    resolveServiceName,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

import {
    getNextAvailableSlots,
    createAppointmentSafe,
    type Slot,
} from "./esteticaModules/schedule/estetica.schedule";

import { addMinutes } from "date-fns";
import { utcToZonedTime, format as tzFormat } from "date-fns-tz";

/* ===========================
   Config / ventanas
   =========================== */
const CONF = {
    MEM_TTL_MIN: 5,
    GRAN_MIN: 15,
    MAX_SLOTS: 6,
    DAYS_HORIZON: 14,
    MAX_HISTORY: 10,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.6,
    MODEL: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
};

// Idempotencia y delays (alineado a agent.strategy)
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000); // 120s
const REPLY_DELAY_FIRST_MS = Number(process.env.REPLY_DELAY_FIRST_MS ?? 180_000);   // 3 min
const REPLY_DELAY_NEXT_MS = Number(process.env.REPLY_DELAY_NEXT_MS ?? 120_000);   // 2 min

const processedInbound = new Map<number, number>(); // messageId -> ts
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && (now - prev) <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = recentReplies.get(conversationId);
    const clientMs = clientTs.getTime();
    if (prev && prev.afterMs >= clientMs && (now - prev.repliedAtMs) <= windowMs) return true;
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now });
    return false;
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    const now = Date.now();
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
}
async function computeReplyDelayMs(conversationId: number) {
    const prevBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        select: { id: true },
    });
    return prevBot ? REPLY_DELAY_NEXT_MS : REPLY_DELAY_FIRST_MS;
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function normalizeToE164(n: string) { return String(n || "").replace(/[^\d]/g, ""); }

/* ===========================
   Utils de formato
   =========================== */
function softTrim(s: string | null | undefined, max = 240) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function endsWithPunctuation(t: string) { return /[.!?…]\s*$/.test((t || "").trim()); }
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

/* ===========================
   conversation_state
   =========================== */
type DraftStage = "idle" | "offer" | "confirm";
type AgentState = {
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    draft?: { name?: string; phone?: string; procedureId?: number; procedureName?: string; whenISO?: string; durationMin?: number; stage?: DraftStage; };
    slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string; };
    summary?: { text: string; expiresAt: string; };
    expireAt?: string;
};
function nowPlusMin(min: number) { return new Date(Date.now() + min * 60_000).toISOString(); }
async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({ where: { conversationId }, select: { data: true } });
    const raw = (row?.data as any) || {};
    const data: AgentState = {
        lastIntent: raw.lastIntent, lastServiceId: raw.lastServiceId ?? null, lastServiceName: raw.lastServiceName ?? null,
        draft: raw.draft ?? {}, slotsCache: raw.slotsCache ?? undefined, summary: raw.summary ?? undefined, expireAt: raw.expireAt,
    };
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    return data;
}
async function saveState(conversationId: number, data: AgentState) {
    const next: AgentState = { ...data, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    await prisma.conversationState.upsert({ where: { conversationId }, create: { conversationId, data: next as any }, update: { data: next as any } });
}
async function patchState(conversationId: number, patch: Partial<AgentState>) {
    const prev = await loadState(conversationId);
    await saveState(conversationId, { ...prev, ...patch });
}

/* ===========================
   Historial y resumen embebido
   =========================== */
type ChatHistoryItem = { role: "user" | "assistant"; content: string };
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = CONF.MAX_HISTORY): Promise<ChatHistoryItem[]> {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({ where, orderBy: { timestamp: "desc" }, take, select: { from: true, contenido: true } });
    return rows.reverse().map((r) => ({ role: r.from === MessageFrom.client ? "user" : "assistant", content: softTrim(r.contenido || "", 220) })) as ChatHistoryItem[];
}
async function buildOrReuseSummary(args: { conversationId: number; kb: EsteticaKB; history: ChatHistoryItem[]; }): Promise<string> {
    const { conversationId, kb, history } = args;

    const state = await loadState(conversationId);
    const fresh = state.summary && Date.now() < Date.parse(state.summary.expiresAt);
    if (fresh) return state.summary!.text;

    const services = (kb.procedures ?? []).filter((s) => s.enabled !== false).map((s) => {
        const desde = s.priceMin ? formatCOP(s.priceMin) : null;
        return desde ? `${s.name} (Desde ${desde} COP)` : s.name;
    }).join(" • ");

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
        kb.policies ? `Políticas: ${softTrim(kb.policies, 240)}` : "",
        kb.exceptions?.length ? `Excepciones próximas: ${kb.exceptions.slice(0, 2).map(e => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`).join(", ")}` : "",
        `Historial: ${history.map(h => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 110)).join(" | ")}`,
    ].filter(Boolean).join("\n");

    let compact = base;
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL, temperature: 0.1, max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) }
                    ],
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL, temperature: 0.1, max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) }
                    ],
                });
        compact = (resp?.choices?.[0]?.message?.content || base).trim().replace(/\n{3,}/g, "\n\n");
    } catch { /* fallback base */ }

    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    console.log("[ESTETICA] summary.ok", { saved: true });
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
function varyPrefix(kind: "greet" | "offer" | "ask" | "ok"): string {
    const sets = {
        greet: ["¡Hola! 👋", "¡Qué gusto verte! 😊", "¡Hola, bienvenid@! ✨"],
        offer: ["Te cuento rápido:", "Mira, te resumo:", "Va muy corto:"],
        ask: ["¿Te paso opciones…?", "¿Seguimos con…?", "¿Quieres ver horarios?"],
        ok: ["Perfecto ✅", "¡Listo! 🙌", "Genial ✨"],
    } as const;
    const arr = sets[kind];
    return arr[Math.floor(Math.random() * arr.length)];
}

/* ===========================
   Persistencia + envío
   =========================== */
async function persistBotReply(opts: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado; to?: string; phoneNumberId?: string;
}) {
    const { conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId } = opts;
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
            console.log("[ESTETICA] sent WA", { wamid, to });
        } catch (e) {
            console.error("[ESTETICA] WA send error:", (e as any)?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* ===========================
   Núcleo
   =========================== */
export async function handleEsteticaReply(args: {
    // acepta ambos nombres para compatibilidad con otros módulos
    chatId?: number;
    conversationId?: number;
    empresaId: number;
    contenido?: string;       // texto recibido limpio
    toPhone?: string;         // destino WhatsApp
    phoneNumberId?: string;   // WABA emisor (hint)
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
        contenido = "",
        toPhone,
        phoneNumberId,
    } = args;

    const conversationId = conversationIdArg ?? chatId;
    if (!conversationId) return { estado: "pendiente", mensaje: "" };

    console.log("[ESTETICA] enter", { conversationId, empresaId, toPhone, phoneNumberId, hasContenido: !!contenido });

    // Conversación + último inbound del cliente
    const conversacion = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { id: true, phone: true, estado: true },
    });
    if (!conversacion) return { estado: "pendiente", mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true },
    });

    // Idempotencia/ventana
    if (last?.id && seenInboundRecently(last.id)) return { estado: "pendiente", mensaje: "" };
    if (last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
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
    const compactContext = await buildOrReuseSummary({ conversationId, kb, history });

    // Servicio + Intención
    const match = resolveServiceName(kb, contenido || "");
    const service = match.procedure ?? (state.lastServiceId ? kb.procedures.find(p => p.id === state.lastServiceId) ?? null : null);
    let intent = detectIntent(contenido);
    if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

    /* ===== Precio ===== */
    if (intent === "price") {
        if (service) {
            const priceLabel = service.priceMin ? `Desde ${formatCOP(service.priceMin)} (COP)` : null;
            const dur = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;
            const dep = service.depositRequired ? formatCOP(service.depositAmount ?? null) : null;
            const piezas = [
                `${varyPrefix("offer")} *${service.name}*`,
                priceLabel ? `💵 ${priceLabel}` : "",
                `⏱️ Aprox. ${dur} min`,
                dep ? `🔐 Anticipo de ${dep}` : "",
            ].filter(Boolean);
            const tail = `${varyPrefix("ask")} ¿quieres ver horarios cercanos? 🗓️`;
            const texto = clampLines(closeNicely(`${piezas.join(" · ")}\n\n${tail}`));

            state.lastIntent = "price";
            state.lastServiceId = service.id;
            state.lastServiceName = service.name;
            await saveState(conversationId, state);

            await sleep(await computeReplyDelayMs(conversationId));
            const saved = await persistBotReply({
                conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } else {
            const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
            const ask = `¿De cuál tratamiento te paso precio? (Ej.: ${nombres}) 😊`;

            await sleep(await computeReplyDelayMs(conversationId));
            const saved = await persistBotReply({
                conversationId, empresaId, texto: ask, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    /* ===== Horarios ===== */
    if (intent === "schedule" && (service || state.draft?.procedureId)) {
        const svc = service || kb.procedures.find((p) => p.id === state.draft?.procedureId)!;
        const duration = svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60;

        const tz = kb.timezone;
        const todayISO = tzFormat(utcToZonedTime(new Date(), tz), "yyyy-MM-dd", { timeZone: tz });

        const slotsByDay = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin: CONF.GRAN_MIN },
            todayISO, duration, CONF.DAYS_HORIZON, CONF.MAX_SLOTS
        );

        const flat = slotsByDay.flatMap(d => d.slots).slice(0, CONF.MAX_SLOTS);
        if (!flat.length) {
            const txt = "No veo cupos cercanos por ahora. ¿Quieres que te contacte un asesor para coordinar? 🤝";
            await sleep(await computeReplyDelayMs(conversationId));
            const saved = await persistBotReply({
                conversationId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        const labeled = flat.map((s: Slot) => {
            const d = new Date(s.startISO);
            const f = d.toLocaleString("es-CO", { weekday: "long", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
            return { startISO: s.startISO, endISO: s.endISO, label: f };
        });

        state.draft = { ...state.draft, procedureId: svc.id, procedureName: svc.name, durationMin: duration, stage: "offer" };
        state.lastIntent = "schedule"; state.lastServiceId = svc.id; state.lastServiceName = svc.name;
        state.slotsCache = { items: labeled, expiresAt: nowPlusMin(10) };
        await saveState(conversationId, state);

        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");
        const texto = `Tengo disponibilidad cercana para *${svc.name}*:\n${bullets}\n\nElige una y dime tu *nombre* y *teléfono* para reservar ✅`;

        await sleep(await computeReplyDelayMs(conversationId));
        const saved = await persistBotReply({
            conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Captura → confirmación ===== */
    const nameMatch = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i.exec(contenido);
    const phoneMatch = /(\+?57)?\s?(\d{10})\b/.exec(contenido.replace(/[^\d+]/g, " "));
    const hhmm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(contenido);

    if ((nameMatch || phoneMatch || hhmm) && state.draft?.stage === "offer" && (state.draft.procedureId || service?.id)) {
        let chosen = state.slotsCache?.items?.[0];
        if (hhmm && state.slotsCache?.items?.length) {
            const hh = `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
            const hit = state.slotsCache.items.find((s) => new Date(s.startISO).toISOString().slice(11, 16) === hh);
            if (hit) chosen = hit;
        }
        if (!chosen && state.slotsCache?.items?.length) chosen = state.slotsCache.items[0];

        const properCase = (v?: string) =>
            (v || "").trim().replace(/\s+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase());

        const draft = {
            ...state.draft,
            name: state.draft.name ?? (nameMatch ? properCase(nameMatch[2]) : undefined),
            phone: state.draft.phone ?? (phoneMatch ? phoneMatch[2] : undefined),
            whenISO: state.draft.whenISO ?? chosen?.startISO,
            stage: "confirm" as DraftStage,
        };
        state.draft = draft;
        await saveState(conversationId, state);

        const local = draft.whenISO ? new Date(draft.whenISO) : null;
        const fecha = local
            ? local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit" })
            : "fecha por confirmar";
        const hora = local
            ? local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false })
            : "hora por confirmar";

        const resumen =
            `${varyPrefix("ok")} Estoy listo para reservar. ¿Confirmas?\n` +
            `• Procedimiento: ${draft.procedureName}\n` +
            `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
            `• Nombre: ${draft.name ?? "—"}\n` +
            `• Teléfono: ${draft.phone ?? "—"}\n\n` +
            `Responde *"confirmo"* y hago la reserva 📅`;

        await sleep(await computeReplyDelayMs(conversationId));
        const saved = await persistBotReply({
            conversationId, empresaId, texto: resumen, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Confirmación final ===== */
    if (/^confirmo\b/i.test(contenido.trim()) && state.draft?.stage === "confirm" && state.draft.whenISO) {
        try {
            const svc = kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0));
            const endISO = new Date(addMinutes(new Date(state.draft.whenISO), state.draft.durationMin ?? (svc?.durationMin ?? 60))).toISOString();

            await createAppointmentSafe({
                empresaId, vertical: kb.vertical as AppointmentVertical | "custom", timezone: kb.timezone,
                procedureId: state.draft.procedureId ?? null, serviceName: state.draft.procedureName || (svc?.name ?? "Procedimiento"),
                customerName: state.draft.name || "Cliente", customerPhone: state.draft.phone || "",
                startISO: state.draft.whenISO, endISO, notes: "Agendado por IA", source: "ai",
            });

            const ok = `¡Hecho! Tu cita quedó confirmada ✅. Te llegará un recordatorio.`;
            state.draft = { stage: "idle" };
            await saveState(conversationId, state);

            await sleep(await computeReplyDelayMs(conversationId));
            const saved = await persistBotReply({
                conversationId, empresaId, texto: ok, nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } catch {
            const fail = `Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?`;
            await sleep(await computeReplyDelayMs(conversationId));
            const saved = await persistBotReply({
                conversationId, empresaId, texto: fail, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    /* ===== Respuesta libre guiada por summary/kb ===== */
    const system = [
        `Eres un asesor de clínica estética en ${kb.timezone}. Tono humano, cálido, breve, con 1–3 emojis. Respuestas únicas (evita plantillas).`,
        `Si el usuario pide *precios*, usa solo los del catálogo. Formato: "Desde $X (COP)".`,
        `Si pide *horarios*, ofrece slots y solicita nombre/teléfono solo si hay intención real.`,
        `Si hay intención de agendar, pide datos y confirma antes de reservar.`,
        `Resumen operativo + catálogo:\n${compactContext}`,
    ].join("\n");

    const userCtx = [
        service ? `Servicio en contexto: ${service.name}` : (state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : ""),
        contenido,
    ].filter(Boolean).join("\n");

    let texto = "";
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 180,
                    messages: [{ role: "system", content: system }, { role: "user", content: userCtx }],
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 180,
                    messages: [{ role: "system", content: system }, { role: "user", content: userCtx }],
                });
        texto = (resp?.choices?.[0]?.message?.content || "").trim();
    } catch {
        texto = "Te ayudo con información de los tratamientos y, si quieres, revisamos horarios para agendar. 🙂";
    }

    texto = clampLines(closeNicely(texto));

    if (service) { state.lastServiceId = service.id; state.lastServiceName = service.name; }
    state.lastIntent = intent === "other" ? state.lastIntent : intent;
    await saveState(conversationId, state);

    await sleep(await computeReplyDelayMs(conversationId));
    const saved = await persistBotReply({
        conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
    return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}

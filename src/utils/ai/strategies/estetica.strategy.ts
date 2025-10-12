// utils/ai/strategies/estetica.strategy.ts
/**
 * Estética – Strategy WhatsApp
 * - Responde INMEDIATO (sin delays)
 * - Sin “Hola” automático
 * - Usa staff según requiredStaffIds o rol
 * - Contexto = historial reciente + summary en conversation_state
 * - Booking con doble confirmación (sin meter Appointment/AppointmentHour al summary)
 */

import prisma from "../../../lib/prisma";
import type { Prisma, AppointmentVertical, StaffRole } from "@prisma/client";
import { MessageFrom, ConversationEstado, MediaType } from "@prisma/client";
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
   Config
   =========================== */
const CONF = {
    MEM_TTL_MIN: 5,
    GRAN_MIN: 15,
    MAX_SLOTS: 6,
    DAYS_HORIZON: 14,
    MAX_HISTORY: 12, // más contexto
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.55,
    MODEL: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
};

// Idempotencia simple
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
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
   conversation_state (memoria)
   =========================== */
type DraftStage = "idle" | "offer" | "confirm";
type AgentState = {
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    draft?: { name?: string; phone?: string; procedureId?: number; procedureName?: string; whenISO?: string; durationMin?: number; stage?: DraftStage; };
    slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string; };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
};
function nowPlusMin(min: number) { return new Date(Date.now() + min * 60_000).toISOString(); }

async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({ where: { conversationId }, select: { data: true } });
    const raw = (row?.data as any) || {};
    const data: AgentState = {
        lastIntent: raw.lastIntent,
        lastServiceId: raw.lastServiceId ?? null,
        lastServiceName: raw.lastServiceName ?? null,
        draft: raw.draft ?? {},
        slotsCache: raw.slotsCache ?? undefined,
        summary: raw.summary ?? undefined,
        expireAt: raw.expireAt,
    };
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
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
    const rows = await prisma.message.findMany({ where, orderBy: { timestamp: "desc" }, take, select: { from: true, contenido: true } });
    return rows.reverse().map((r) => ({ role: r.from === MessageFrom.client ? "user" : "assistant", content: softTrim(r.contenido || "", 280) })) as ChatHistoryItem[];
}

async function buildOrReuseSummary(args: { conversationId: number; kb: EsteticaKB; history: ChatHistoryItem[]; }): Promise<string> {
    const { conversationId, kb, history } = args;

    // reusar si aún válido
    const cached = await loadState(conversationId);
    const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
    if (fresh) return cached.summary!.text;

    // ===== construir resumen (incluye staff, pero NO slots ni citas) =====
    const services = (kb.procedures ?? [])
        .filter((s) => s.enabled !== false)
        .map((s) => {
            const desde = s.priceMin ? formatCOP(s.priceMin) : null;
            return desde ? `${s.name} (Desde ${desde} COP)` : s.name;
        }).join(" • ");

    const staffByRole: Record<StaffRole, string[]> = { esteticista: [], medico: [], profesional: [] } as any;
    (kb.staff || []).forEach(s => { if (s.active) (staffByRole[s.role] ||= []).push(s.name); });

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
        kb.policies ? `Políticas: ${softTrim(kb.policies, 240)}` : "",
        kb.exceptions?.length
            ? `Excepciones próximas: ${kb.exceptions.slice(0, 2).map(e => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`).join(", ")}` : "",
        `Historial breve: ${history.slice(-6).map(h => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 100)).join(" | ")}`,
    ].filter(Boolean).join("\n");

    let compact = base;
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL, temperature: 0.1, max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) },
                    ],
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL, temperature: 0.1, max_tokens: 220,
                    messages: [
                        { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
                        { role: "user", content: base.slice(0, 4000) },
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
   Staff helper
   =========================== */
function pickStaffForProcedure(kb: EsteticaKB, proc?: EsteticaKB["procedures"][number] | null) {
    const active = (kb.staff || []).filter(s => s.active);
    if (!active.length) return null;

    if (proc?.requiredStaffIds?.length) {
        const byId = active.find(s => proc.requiredStaffIds!.includes(s.id));
        if (byId) return byId;
    }
    // Heurística por rol
    if (proc?.requiresAssessment) {
        const medico = active.find(s => s.role === "medico");
        if (medico) return medico;
    }
    const esteticista = active.find(s => s.role === "esteticista");
    if (esteticista) return esteticista;

    return active[0];
}

/* ===========================
   Persistencia + envío WhatsApp
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

    console.log("[ESTETICA] enter", { conversationId, empresaId, toPhone, phoneNumberId, hasContenido: !!contenido });

    // Conversación + último inbound
    const conversacion = await prisma.conversation.findUnique({
        where: { id: conversationId }, select: { id: true, phone: true, estado: true },
    });
    if (!conversacion) return { estado: "pendiente", mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true, contenido: true, mediaType: true, caption: true },
    });

    // Idempotencia
    if (last?.id && seenInboundRecently(last.id)) return { estado: "pendiente", mensaje: "" };
    if (last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
        return { estado: "pendiente", mensaje: "" };
    }

    // Fallback de contenido si viene vacío
    if (!contenido) {
        if (last?.contenido && last.contenido.trim()) contenido = last.contenido.trim();
        else if (last?.mediaType === MediaType.image && last?.caption) contenido = String(last.caption).trim();
        else contenido = "…";
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
    state = await loadState(conversationId); // refrescar summary guardado

    // Servicio + Intención
    const match = resolveServiceName(kb, contenido || "");
    const service = match.procedure ?? (state.lastServiceId ? kb.procedures.find(p => p.id === state.lastServiceId) ?? null : null);
    let intent = detectIntent(contenido);
    if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

    /* ===== Pregunta por quién realiza / profesional ===== */
    if (/\b(qu[ié]n|quien|persona|profesional|doctor|doctora|m[eé]dico|esteticista).*(hace|realiza|atiende|me va a hacer)\b/i.test(contenido)) {
        const whoProc = service || (state.lastServiceId ? kb.procedures.find(p => p.id === state.lastServiceId) : null);
        const staff = pickStaffForProcedure(kb, whoProc || undefined);
        const labelSvc = whoProc?.name ? `*${whoProc.name}* ` : "";
        const texto = staff
            ? `${labelSvc}lo realiza ${staff.role === "medico" ? "la/el Dr(a)." : ""} *${staff.name}*. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Quieres ver horarios?`
            : `${labelSvc}lo realiza un profesional de nuestro equipo. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Te paso horarios?`;

        await patchState(conversationId, { lastIntent: "info", ...(whoProc ? { lastServiceId: whoProc.id, lastServiceName: whoProc.name } : {}) });
        const saved = await persistBotReply({
            conversationId, empresaId, texto: clampLines(closeNicely(texto)), nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Respuesta “¿Qué servicios…?” ===== */
    if (/que\s+servicios|qué\s+servicios|servicios\s+ofreces?/i.test(contenido)) {
        const items = kb.procedures.slice(0, 6).map(p => {
            const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
            return `• ${p.name}${desde}`;
        }).join("\n");
        const tail = `¿Te paso precios de alguno u horarios para agendar?`;
        const texto = clampLines(closeNicely(`${items}\n\n${tail}`));

        await patchState(conversationId, { lastIntent: "info" });
        const saved = await persistBotReply({
            conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Precio ===== */
    if (intent === "price") {
        if (service) {
            const priceLabel = service.priceMin ? `Desde ${formatCOP(service.priceMin)} (COP)` : null;
            const dur = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;
            const dep = service.depositRequired ? formatCOP(service.depositAmount ?? null) : null;
            const staff = pickStaffForProcedure(kb, service);
            const piezas = [
                `${varyPrefix("offer")} *${service.name}*`,
                priceLabel ? `💵 ${priceLabel}` : "",
                `⏱️ Aprox. ${dur} min`,
                staff ? `👩‍⚕️ Profesional: ${staff.name}` : "",
                dep ? `🔐 Anticipo de ${dep}` : "",
            ].filter(Boolean);
            const tail = `${varyPrefix("ask")} ¿quieres ver horarios cercanos? 🗓️`;
            const texto = clampLines(closeNicely(`${piezas.join(" · ")}\n\n${tail}`));

            await patchState(conversationId, { lastIntent: "price", lastServiceId: service.id, lastServiceName: service.name });
            const saved = await persistBotReply({
                conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } else {
            const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
            const ask = `¿De cuál tratamiento te paso precio? (Ej.: ${nombres})`;

            await patchState(conversationId, { lastIntent: "price" });
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
            const txt = "No veo cupos cercanos por ahora. ¿Quieres que te contacte un asesor para coordinar?";
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

        await patchState(conversationId, {
            draft: { ...(state.draft ?? {}), procedureId: svc.id, procedureName: svc.name, durationMin: duration, stage: "offer" },
            lastIntent: "schedule", lastServiceId: svc.id, lastServiceName: svc.name,
            slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
        });

        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");
        const texto = `Disponibilidad cercana para *${svc.name}*:\n${bullets}\n\nElige una y dime tu *nombre* y *teléfono* para reservar.`;

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
        const currentCache = (await loadState(conversationId)).slotsCache; // refrescar
        let chosen = currentCache?.items?.[0];
        if (hhmm && currentCache?.items?.length) {
            const hh = `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
            const hit = currentCache.items.find((s) => new Date(s.startISO).toISOString().slice(11, 16) === hh);
            if (hit) chosen = hit;
        }

        const properCase = (v?: string) =>
            (v || "").trim().replace(/\s+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase());

        const draft = {
            ...(state.draft ?? {}),
            name: state.draft?.name ?? (nameMatch ? properCase(nameMatch[2]) : undefined),
            phone: state.draft?.phone ?? (phoneMatch ? phoneMatch[2] : undefined),
            whenISO: state.draft?.whenISO ?? chosen?.startISO,
            stage: "confirm" as DraftStage,
            procedureName: state.draft?.procedureName ?? service?.name,
            procedureId: state.draft?.procedureId ?? service?.id,
        };

        await patchState(conversationId, { draft });

        const local = draft.whenISO ? new Date(draft.whenISO) : null;
        const fecha = local
            ? local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit" })
            : "fecha por confirmar";
        const hora = local
            ? local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false })
            : "hora por confirmar";

        const resumen =
            `${varyPrefix("ok")} ¿confirmas la reserva?\n` +
            `• Procedimiento: ${draft.procedureName ?? "—"}\n` +
            `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
            `• Nombre: ${draft.name ?? "—"}\n` +
            `• Teléfono: ${draft.phone ?? "—"}\n\n` +
            `Responde *"confirmo"* y creo la cita.`;

        const saved = await persistBotReply({
            conversationId, empresaId, texto: resumen, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
        return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ===== Confirmación final (revalidación) ===== */
    const latestState = await loadState(conversationId);
    if (/^confirmo\b/i.test(contenido.trim()) && latestState.draft?.stage === "confirm" && latestState.draft.whenISO) {
        try {
            const svc = kb.procedures.find((p) => p.id === (latestState.draft?.procedureId ?? 0));
            const endISO = new Date(addMinutes(new Date(latestState.draft.whenISO), latestState.draft.durationMin ?? (svc?.durationMin ?? 60))).toISOString();

            await createAppointmentSafe({
                empresaId, vertical: kb.vertical as AppointmentVertical | "custom", timezone: kb.timezone,
                procedureId: latestState.draft.procedureId ?? null, serviceName: latestState.draft.procedureName || (svc?.name ?? "Procedimiento"),
                customerName: latestState.draft.name || "Cliente", customerPhone: latestState.draft.phone || "",
                startISO: latestState.draft.whenISO, endISO, notes: "Agendado por IA", source: "ai",
            });

            const ok = `¡Hecho! Tu cita quedó confirmada ✅. Te enviaremos recordatorio antes de la fecha.`;
            await patchState(conversationId, { draft: { stage: "idle" } });

            const saved = await persistBotReply({
                conversationId, empresaId, texto: ok, nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } catch {
            const fail = `Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?`;
            const saved = await persistBotReply({
                conversationId, empresaId, texto: fail, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
            return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    /* ===== Respuesta libre con contexto (sin “Hola”) ===== */
    const system = [
        `Eres asesor de una clínica estética (${kb.timezone}).`,
        `Responde directo, **no inicies con saludos** ni despedidas; evita “Hola”.`,
        `Sé breve (2–5 líneas máx), natural, y usa emojis solo si aportan (0–2).`,
        `Si piden *precios*, usa solo los del catálogo y el formato: "Desde $X (COP)".`,
        `Si piden *horarios*, ofrece slots y solicita nombre/teléfono sólo si hay intención real.`,
        `Si hay intención de agendar, pide datos mínimos y confirma antes de reservar.`,
        `Resumen operativo + catálogo (contexto):\n${compactContext}`,
    ].join("\n");

    const userCtx = [
        service ? `Servicio en contexto: ${service.name}` : (state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : ""),
        `Usuario: ${contenido}`,
    ].filter(Boolean).join("\n");

    // ➕ historial real al modelo (mantiene el hilo)
    const dialogMsgs = history.slice(-6).map(h => ({ role: h.role, content: h.content }));

    let texto = "";
    try {
        const resp: any =
            (openai as any).chat?.completions?.create
                ? await (openai as any).chat.completions.create({
                    model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190,
                    messages: [{ role: "system", content: system }, ...dialogMsgs, { role: "user", content: userCtx }],
                })
                : await (openai as any).createChatCompletion({
                    model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190,
                    messages: [{ role: "system", content: system }, ...dialogMsgs as any, { role: "user", content: userCtx }],
                });
        texto = (resp?.choices?.[0]?.message?.content || "").trim();
    } catch {
        texto = "Te ayudo con información de los tratamientos y, si quieres, revisamos horarios para agendar.";
    }

    // limpieza & guardado de estado
    texto = clampLines(closeNicely(texto));
    await patchState(conversationId, {
        lastIntent: intent === "other" ? state.lastIntent : intent,
        ...(service ? { lastServiceId: service.id, lastServiceName: service.name } : {}),
    });

    const saved = await persistBotReply({
        conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
    return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}

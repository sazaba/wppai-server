// utils/ai/strategies/estetica.strategy.ts
// Full-agent unificado (agenda natural + tools + KB) con respuesta inmediata.

import prisma from "../../../lib/prisma";
import * as Wam from "../../../services/whatsapp.service";
import { ConversationEstado, MessageFrom } from "@prisma/client";
import type { IAReplyResult } from "../../handleIAReply.ecommerce";

// Agente y contexto (RAG)
import { loadApptContext, type EsteticaCtx } from "./esteticaModules/domain/estetica.rag";
import { runEsteticaAgent, type ChatTurn } from "./esteticaModules/domain/estetica.agent";

/* -------------------- Tipos locales para overrides -------------------- */
type ApptConfigOverrides = {
    vertical?: string;
    verticalCustom?: string | null;
    timezone?: string;
    bufferMin?: number;
    enabled?: boolean;
    policies?: string | null;
    reminders?: boolean;
    services?: any[];
    servicesText?: string;
    logistics?: {
        locationName?: string;
        locationAddress?: string;
        locationMapsUrl?: string;
        parkingInfo?: string;
        virtualMeetingLink?: string;
        instructionsArrival?: string;
    };
    rules?: {
        cancellationWindowHours?: number;
        noShowPolicy?: string;
        depositRequired?: boolean;
        depositAmount?: any;
        maxDailyAppointments?: number;
        bookingWindowDays?: number;
        blackoutDates?: any;
        overlapStrategy?: string;
        minNoticeHours?: number;
        appointmentMinNoticeHours?: number;
        appointmentMaxAdvanceDays?: number;
        allowSameDay?: boolean;
        allowSameDayBooking?: boolean;
        requireConfirmation?: boolean;
        requireClientConfirmation?: boolean;
        defaultServiceDurationMin?: number;
    };
    remindersConfig?: {
        schedule?: any;
        templateId?: string;
        postBookingMessage?: string;
    };
    kb?: {
        businessOverview?: string;
        faqs?: any;
        serviceNotes?: any;
        escalationRules?: any;
        disclaimers?: string;
        media?: any;
        freeText?: string;
    };
};

/* ========================= Anti doble respuesta ========================= */
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
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
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: Date.now() });
}

function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

/* ========================= Persistencia + envío WA ========================= */
async function persistBotReply({
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
    to?: string;
    phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });

    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid) {
                await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
            }
        } catch (err) {
            console.error("[ESTETICA] WhatsApp send error:", (err as any)?.message || err);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* ========================= Estrategia principal ========================= */
export async function handleEsteticaReply(args: {
    chatId: number;
    empresaId: number;
    mensajeArg: string;
    toPhone?: string;
    phoneNumberId?: string;
    apptConfig?: unknown; // viene del orquestador; lo normalizamos abajo
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg, toPhone, phoneNumberId, apptConfig } = args;

    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true, empresaId: true },
    });
    if (!conversacion) return null;
    if (conversacion.estado === ConversationEstado.cerrado) {
        console.warn(`[handleEsteticaReply] Chat ${chatId} está cerrado.`);
        return null;
    }

    // 👇 nombre de la empresa para el saludo y tono
    const empresa = await prisma.empresa.findUnique({
        where: { id: conversacion.empresaId },
        select: { nombre: true },
    });

    // último mensaje del cliente
    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true, contenido: true },
    });
    const userText = (mensajeArg || last?.contenido || "").trim() || "Hola";

    if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp)) {
        if (process.env.DEBUG_AI === "1") console.log("[ESTETICA] Skip: double reply window");
        return null;
    }

    // === Cargar contexto RAG (desde DB o con overrides del orquestador)
    const cfg = (apptConfig ?? {}) as ApptConfigOverrides;

    const ctx: EsteticaCtx = await loadApptContext(
        empresaId,
        {
            vertical: cfg.vertical ?? "custom",
            timezone: cfg.timezone ?? "America/Bogota",
            bufferMin: cfg.bufferMin ?? 10,
            policies: cfg.policies ?? null,
            logistics: cfg.logistics,
            rules: cfg.rules,
            remindersConfig: cfg.remindersConfig,
            kb: cfg.kb,
            // 👇 pasamos marca
            businessName: empresa?.nombre ?? undefined,
        } as any
    );

    // === Historial compacto → ChatTurn[]
    const historyRaw = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: "desc" },
        take: 8,
        select: { from: true, contenido: true },
    });
    const turns: ChatTurn[] = historyRaw
        .reverse()
        .filter((m) => (m.contenido || "").trim().length > 0)
        .map((m) => ({
            role: m.from === MessageFrom.client ? "user" : "assistant",
            content: m.contenido || "",
        }))
        .concat([{ role: "user", content: userText }]);

    // === Ejecutar agente
    let texto = "";
    try {
        texto = await runEsteticaAgent({ ...ctx, __conversationId: chatId }, turns);
    } catch (err: any) {
        console.error("[ESTETICA] runEsteticaAgent error:", err?.message || err);
        texto =
            `¡Hola! Soy coordinación de ${empresa?.nombre ?? "la clínica"}. ` +
            "Puedo ayudarte con información de tratamientos o mostrarte horarios desde mañana. ¿Qué te gustaría hacer? 🙂";
    }

    // === Persistir y enviar por WhatsApp
    const saved = await persistBotReply({
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

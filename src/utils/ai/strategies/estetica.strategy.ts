// utils/ai/strategies/estetica.strategy.ts
// Full-agent unificado (agenda natural + tools + KB) con flujo compatible con agent.strategy
// *** Respuesta inmediata: sin retrasos configurados ***

import prisma from "../../../lib/prisma"
import * as Wam from "../../../services/whatsapp.service"
import { ConversationEstado, MessageFrom } from "@prisma/client"
import type { IAReplyResult } from "../../handleIAReply.ecommerce"

// 👇 Importa contexto (RAG) y MOTOR del agente de estética
import { loadApptContext, type EsteticaCtx } from "./esteticaModules/domain/estetica.rag"
import { runEsteticaAgent, type ChatTurn } from "./esteticaModules/domain/estetica.agent"

// === Desactivamos delays (respuesta inmediata)
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000)
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>()

function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now()
    const prev = recentReplies.get(conversationId)
    const clientMs = clientTs.getTime()
    if (prev && prev.afterMs >= clientMs && (now - prev.repliedAtMs) <= windowMs) return true
    recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now })
    return false
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: Date.now() })
}
function normalizeToE164(n: string) { return String(n || "").replace(/[^\d]/g, "") }

async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId,
}: {
    conversationId: number
    empresaId: number
    texto: string
    nuevoEstado: ConversationEstado
    to?: string
    phoneNumberId?: string
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    })
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } })

    let wamid: string | undefined
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId,
            })
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } })
        } catch (err) {
            console.error("[ESTETICA] WhatsApp send error:", (err as any)?.message || err)
        }
    }
    return { messageId: msg.id, texto, wamid }
}

/* ============================================================== */
export async function handleEsteticaReply(args: {
    chatId: number
    empresaId: number
    mensajeArg: string
    toPhone?: string
    phoneNumberId?: string
    apptConfig?: any
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg, toPhone, phoneNumberId, apptConfig } = args

    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true },
    })
    if (!conversacion) return null
    if (conversacion.estado === ConversationEstado.cerrado) {
        console.warn(`[handleEsteticaReply] Chat ${chatId} está cerrado.`)
        return null
    }

    // último mensaje del cliente
    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, timestamp: true, contenido: true },
    })
    const userText = (mensajeArg || last?.contenido || "").trim() || "Hola"

    if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp)) {
        if (process.env.DEBUG_AI === "1") console.log("[ESTETICA] Skip: double reply window")
        return null
    }

    // === Contexto RAG / reglas (acepta override desde orquestador)
    const ctx: EsteticaCtx = await loadApptContext(
        empresaId,
        apptConfig
            ? {
                vertical: apptConfig.vertical ?? "custom",
                timezone: apptConfig.timezone ?? "America/Bogota",
                bufferMin: apptConfig.bufferMin ?? 10,
                policies: apptConfig.policies,
                logistics: apptConfig.logistics,
                appointmentMinNoticeHours: apptConfig?.rules?.appointmentMinNoticeHours ?? apptConfig?.rules?.minNoticeHours,
                appointmentMaxAdvanceDays: apptConfig?.rules?.appointmentMaxAdvanceDays ?? apptConfig?.rules?.maxAdvanceDays,
                allowSameDayBooking: apptConfig?.rules?.allowSameDayBooking ?? apptConfig?.rules?.allowSameDay,
                requireClientConfirmation: apptConfig?.rules?.requireClientConfirmation ?? apptConfig?.rules?.requireConfirmation,
                defaultServiceDurationMin: apptConfig?.rules?.defaultServiceDurationMin,
                bookingWindowDays: apptConfig?.rules?.bookingWindowDays,
                maxDailyAppointments: apptConfig?.rules?.maxDailyAppointments,
                blackoutDates: apptConfig?.rules?.blackoutDates,
                overlapStrategy: apptConfig?.rules?.overlapStrategy,
                kb: apptConfig?.kb,
            }
            : undefined
    )

    // === Historial (compacto) → ChatTurn[]
    const historyRaw = await prisma.message.findMany({
        where: { conversationId: chatId },
        orderBy: { timestamp: "desc" },
        take: 8,
        select: { from: true, contenido: true },
    })
    const turns: ChatTurn[] = historyRaw.reverse().map(m => ({
        role: m.from === MessageFrom.client ? "user" : "assistant",
        content: (m.contenido || ""),
    }))

    // === LLM (motor)
    let texto = ""
    try {
        texto = await runEsteticaAgent({ ...ctx, __conversationId: chatId }, [
            ...turns,
            { role: "user", content: userText },
        ])
    } catch (err: any) {
        console.error("[ESTETICA] runEsteticaAgent error:", err?.message || err)
        // fallback: saludo natural, sin sonar a bot
        texto = "¡Hola! Puedo ayudarte con información de tratamientos o mostrarte horarios desde mañana. ¿Qué te gustaría hacer? 🙂"
    }

    // === persistir & enviar por WhatsApp (SIN ESPERA)
    const saved = await persistBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    })

    if (last?.timestamp) markActuallyReplied(chatId, last.timestamp)

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    }
}

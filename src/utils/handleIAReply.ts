// server/src/utils/handleIAReply.ts
import prisma from '../lib/prisma'
import { handleEcommerceIAReply, type IAReplyResult } from './handleIAReply.ecommerce'
import { handleAgentReply } from './ai/strategies/agent.strategy'
import { handleAppointmentsReply } from './ai/strategies/appointments.strategy'
import { AiMode, AgentSpecialty, ConversationEstado } from '@prisma/client'

export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }
): Promise<IAReplyResult | null> => {
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true }
    })
    if (!conversacion) return null

    if (conversacion.estado === ConversationEstado.cerrado) {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`)
        return null
    }

    const config = await prisma.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
        select: {
            id: true,
            aiMode: true,
            agentSpecialty: true,
            agentPrompt: true,
            agentScope: true,
            agentDisclaimers: true,
            appointmentEnabled: true,
            appointmentVertical: true,
            servicios: true,
        }
    })

    const mode = config?.aiMode ?? AiMode.ecommerce

    // 👉 NUEVO: modo citas
    if (mode === AiMode.appointments) {
        return handleAppointmentsReply({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId
        })
    }

    if (mode === AiMode.agente) {
        return handleAgentReply({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            agent: {
                specialty: (config?.agentSpecialty ?? AgentSpecialty.generico),
                prompt: config?.agentPrompt ?? '',
                scope: config?.agentScope ?? '',
                disclaimers: config?.agentDisclaimers ?? ''
            }
        })
    }

    // Default/back-compat → e-commerce
    return handleEcommerceIAReply(chatId, mensajeArg, opts)
}

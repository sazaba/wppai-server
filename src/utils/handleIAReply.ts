import prisma from '../lib/prisma'
import { handleEcommerceIAReply, type IAReplyResult } from './handleIAReply.ecommerce'
import { handleAgentReply } from './ai/strategies/agent.strategy'
import { handleEsteticaReply } from './ai/strategies/estetica.strategy'
import {
    AiMode,
    AgentSpecialty,
    ConversationEstado,
} from '@prisma/client'

type OrchestratorOpts = { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }

// ——— helpers de normalización para evitar problemas de Prisma.Json/unknown
function asArray<T = unknown>(v: unknown): T[] | undefined {
    if (Array.isArray(v)) return v as T[]
    return undefined
}

function resolveAiMode(
    bcMode: AiMode | null | undefined,
    bcaMode: AiMode | null | undefined,
    bcaEnabled: boolean | undefined
): AiMode {
    if (bcaMode && (bcaMode === AiMode.appts || bcaMode === AiMode.estetica)) return bcaMode
    if (bcMode) return bcMode
    if (bcaEnabled) return AiMode.appts
    return AiMode.ecommerce
}

export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: OrchestratorOpts
): Promise<IAReplyResult | null> => {
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true },
    })
    if (!conversacion) return null

    if (conversacion.estado === ConversationEstado.cerrado) {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`)
        return null
    }

    const [bc, bca] = await Promise.all([
        prisma.businessConfig.findFirst({
            where: { empresaId: conversacion.empresaId },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                aiMode: true,
                agentSpecialty: true,
                agentPrompt: true,
                agentScope: true,
                agentDisclaimers: true,
                servicios: true,
            },
        }),
        prisma.businessConfigAppt.findUnique({
            where: { empresaId: conversacion.empresaId },
            select: {
                id: true,
                aiMode: true,
                appointmentEnabled: true,
                appointmentVertical: true,
                appointmentVerticalCustom: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentPolicies: true,
                appointmentReminders: true,
                servicesText: true,
                services: true, // Prisma.JsonValue
                locationName: true,
                locationAddress: true,
                locationMapsUrl: true,
                parkingInfo: true,
                virtualMeetingLink: true,
                instructionsArrival: true,
                cancellationWindowHours: true,
                noShowPolicy: true,
                depositRequired: true,
                depositAmount: true,
                maxDailyAppointments: true,
                bookingWindowDays: true,
                blackoutDates: true,       // Prisma.JsonValue
                overlapStrategy: true,
                reminderSchedule: true,    // Prisma.JsonValue
                reminderTemplateId: true,
                postBookingMessage: true,
                prepInstructionsPerSvc: true,
                kbBusinessOverview: true,
                kbFAQs: true,              // Prisma.JsonValue
                kbServiceNotes: true,      // Prisma.JsonValue
                kbEscalationRules: true,   // Prisma.JsonValue
                kbDisclaimers: true,
                kbMedia: true,             // Prisma.JsonValue
                kbFreeText: true,
            },
        }),
    ])

    const mode = resolveAiMode(bc?.aiMode ?? null, bca?.aiMode ?? null, bca?.appointmentEnabled ?? false)

    // —— Citas / Estética
    if (mode === AiMode.appts || mode === AiMode.estetica) {
        return handleEsteticaReply({
            chatId,
            empresaId: conversacion.empresaId,
            contenido: mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            // Normalizamos aquí todos los JSON/unknown a tipos “seguros”

        })
    }

    // —— Agente
    if (mode === AiMode.agente) {
        return handleAgentReply({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            agent: {
                specialty: (bc?.agentSpecialty ?? AgentSpecialty.generico),
                prompt: bc?.agentPrompt ?? '',
                scope: bc?.agentScope ?? '',
                disclaimers: bc?.agentDisclaimers ?? '',
            },
        })
    }

    // —— E-commerce
    return handleEcommerceIAReply(chatId, mensajeArg, opts)
}

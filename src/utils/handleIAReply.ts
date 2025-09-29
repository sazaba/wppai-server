import prisma from '../lib/prisma'
import { handleEcommerceIAReply, type IAReplyResult } from './handleIAReply.ecommerce'
import { handleAgentReply } from './ai/strategies/agent.strategy'
import { handleEsteticaReply } from './ai/strategies/estetica.strategy'
import {
    AiMode,
    AgentSpecialty,
    ConversationEstado,
    AppointmentVertical,
} from '@prisma/client'

type OrchestratorOpts = { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }

function resolveAiMode(
    bcMode: AiMode | null | undefined,
    bcaMode: AiMode | null | undefined,
    bcaEnabled: boolean | undefined
): AiMode {
    // 1) prioridad al modo explícito en la tabla de citas
    if (bcaMode && (bcaMode === AiMode.appts || bcaMode === AiMode.estetica)) return bcaMode
    // 2) luego el modo general
    if (bcMode) return bcMode
    // 3) inferencia por flag de agenda
    if (bcaEnabled) return AiMode.appts
    // 4) fallback
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

    // Lee ambas configuraciones en paralelo
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
                servicios: true, // útil para ecommerce/agent si lo usas como base
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
                services: true,
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
                blackoutDates: true,
                overlapStrategy: true,
                reminderSchedule: true,
                reminderTemplateId: true,
                postBookingMessage: true,
                prepInstructionsPerSvc: true,
                kbBusinessOverview: true,
                kbFAQs: true,
                kbServiceNotes: true,
                kbEscalationRules: true,
                kbDisclaimers: true,
                kbMedia: true,
                kbFreeText: true,
            },
        }),
    ])

    const mode = resolveAiMode(bc?.aiMode ?? null, bca?.aiMode ?? null, bca?.appointmentEnabled ?? false)

    // 👉 Citas / Estética (usa la tabla businessconfig_appt)
    if (mode === AiMode.appts || mode === AiMode.estetica) {
        return handleEsteticaReply({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            // Pasa configuración especializada de la tabla de citas (opcional en el strategy)
            apptConfig: bca ? {
                timezone: bca.appointmentTimezone ?? 'America/Bogota',
                bufferMin: bca.appointmentBufferMin ?? 10,
                vertical: (bca.appointmentVertical ?? AppointmentVertical.custom),
                verticalCustom: bca.appointmentVerticalCustom ?? null,
                enabled: !!bca.appointmentEnabled,
                policies: bca.appointmentPolicies ?? null,
                reminders: !!bca.appointmentReminders,
                services: (Array.isArray(bca.services) ? bca.services : undefined),
                servicesText: bca.servicesText ?? undefined,
                logistics: {
                    locationName: bca.locationName ?? undefined,
                    locationAddress: bca.locationAddress ?? undefined,
                    locationMapsUrl: bca.locationMapsUrl ?? undefined,
                    virtualMeetingLink: bca.virtualMeetingLink ?? undefined,
                    parkingInfo: bca.parkingInfo ?? undefined,
                    instructionsArrival: bca.instructionsArrival ?? undefined,
                },
                rules: {
                    cancellationWindowHours: bca.cancellationWindowHours ?? undefined,
                    noShowPolicy: bca.noShowPolicy ?? undefined,
                    depositRequired: bca.depositRequired ?? undefined,
                    depositAmount: bca.depositAmount ?? undefined,
                    maxDailyAppointments: bca.maxDailyAppointments ?? undefined,
                    bookingWindowDays: bca.bookingWindowDays ?? undefined,
                    blackoutDates: bca.blackoutDates ?? undefined,
                    overlapStrategy: bca.overlapStrategy ?? undefined,
                },
                remindersConfig: {
                    schedule: bca.reminderSchedule ?? undefined,
                    templateId: bca.reminderTemplateId ?? undefined,
                    postBookingMessage: bca.postBookingMessage ?? undefined,
                },
                kb: {
                    businessOverview: bca.kbBusinessOverview ?? undefined,
                    faqs: bca.kbFAQs ?? undefined,
                    serviceNotes: bca.kbServiceNotes ?? undefined,
                    escalationRules: bca.kbEscalationRules ?? undefined,
                    disclaimers: bca.kbDisclaimers ?? undefined,
                    media: bca.kbMedia ?? undefined,
                    freeText: bca.kbFreeText ?? undefined,
                },
            } : undefined,
        })
    }

    // 👉 Agente (tabla businessconfig)
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

    // 👉 Default/back-compat → e-commerce
    return handleEcommerceIAReply(chatId, mensajeArg, opts)
}

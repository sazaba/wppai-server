// server/src/utils/handleIAReply.ts
import prisma from '../lib/prisma'
import { handleEcommerceIAReply, type IAReplyResult } from './handleIAReply.ecommerce'
import { handleAgentReply } from './ai/strategies/agent.strategy'

/**
 * Orquestador: decide la estrategia según BusinessConfig.aiMode
 * - aiMode = ecommerce  -> delega a lógica existente (intacta)
 * - aiMode = agente     -> usa el agente personalizado (con specialty)
 *
 * La firma se mantiene igual a la de tu implementación original para no romper callers.
 */
export const handleIAReply = async (
    chatId: number,
    mensajeArg: string,
    opts?: { toPhone?: string; autoSend?: boolean; phoneNumberId?: string }
): Promise<IAReplyResult | null> => {
    // Leer conversación
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true },
    })
    if (!conversacion || conversacion.estado === 'cerrado') {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`)
        return null
    }

    // Leer config mínima para decidir estrategia
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
        }

    })

    const mode = config?.aiMode || 'ecommerce'

    if (mode === 'agente') {
        return handleAgentReply({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            agent: {
                specialty: (config?.agentSpecialty as any) || 'generico',
                prompt: config?.agentPrompt || '',
                scope: config?.agentScope || '',
                disclaimers: config?.agentDisclaimers || '',
            },
        })
    }

    // Default/back-compat → e-commerce intacto
    return handleEcommerceIAReply(chatId, mensajeArg, opts)
}


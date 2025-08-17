// src/controllers/chat.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { ConversationEstado, MessageFrom } from '@prisma/client'
import { handleIAReply } from '../utils/handleIAReply'
import { sendOutboundMessage, sendTemplate } from '../services/whatsapp.services'
// 🆕 importar el firmador de URLs cortas para media
import { signMediaToken } from './whatsapp.controller'

// Helper para socket
const getIO = (req: Request) => req.app.get('io')

// 🆕 helper: si hay mediaId y no hay mediaUrl público, genera URL firmada del proxy
function withSignedMediaUrl<T extends { mediaUrl?: string | null; mediaId?: string | null }>(
    m: T,
    empresaId: number
): T {
    const mediaUrl = (m.mediaUrl || '').trim()
    if ((!mediaUrl || mediaUrl.length === 0) && m.mediaId) {
        const t = signMediaToken(empresaId, String(m.mediaId))
        return {
            ...m,
            mediaUrl: `/api/whatsapp/media/${m.mediaId}?t=${encodeURIComponent(t)}`,
        }
    }
    return m
}

// ——————————————————————————————
// GET conversaciones
// ——————————————————————————————
export const getConversations = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId

    try {
        const conversations = await prisma.conversation.findMany({
            where: { empresaId },
            orderBy: { createdAt: 'desc' },
            include: {
                mensajes: {
                    orderBy: { timestamp: 'desc' },
                    take: 1,
                },
            },
        })

        const formatted = conversations.map((c) => ({
            id: c.id,
            nombre: c.nombre ?? c.phone,
            mensaje: c.mensajes[0]?.contenido ?? '',
            estado: c.estado,
            fecha: c.mensajes[0]?.timestamp?.toISOString() ?? '',
        }))

        res.json(formatted)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Error al obtener conversaciones' })
    }
}

// ——————————————————————————————
// GET mensajes de una conversación (paginado)
// ——————————————————————————————
export const getMessagesByConversation = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const skip = (page - 1) * limit

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para ver esta conversación' })
        }

        const total = await prisma.message.count({ where: { conversationId: conv.id } })
        const messages = await prisma.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { timestamp: 'asc' },
            skip,
            take: limit,
            // Nota: no cambiamos tu select; asumimos que message incluye mediaId/mediaUrl si existen
        })

        // 🆕: firmar mediaUrl cuando solo tenemos mediaId (necesario para <img>/<video>)
        const messagesSigned = messages.map((m) => withSignedMediaUrl(m, empresaId))

        res.json({
            messages: messagesSigned,
            pagination: { total, page, limit, hasMore: skip + limit < total },
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Error al obtener mensajes' })
    }
}

// ——————————————————————————————
// POST enviar mensaje manual del agente
// Evita duplicado/rol 'bot': NO pases conversationId al service.
// Persiste tú como AGENTE.
// ——————————————————————————————
export const responderManual = async (req: Request, res: Response) => {
    const { id } = req.params
    const { contenido } = req.body as { contenido?: string }
    const empresaId = (req as any).user?.empresaId

    if (!contenido?.trim()) {
        return res.status(400).json({ error: 'El contenido del mensaje es requerido' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        // 1) Enviar a WhatsApp (NO pasar conversationId para evitar persistencia automática como 'bot')
        await sendOutboundMessage({
            empresaId: conv.empresaId,
            to: conv.phone,
            body: contenido,
            // no conversationId !
        })

        // 2) Persistir como AGENTE en nuestra DB
        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                empresaId: conv.empresaId,
                from: MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        })

        // 3) Actualizar estado (ajusta a tu gusto)
        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: ConversationEstado.respondido },
        })

        // 4) Emitir socket en el formato que tu frontend espera
        const io = getIO(req)
        io?.emit?.('nuevo_mensaje', {
            conversationId: conv.id,
            message,
        })

        res.status(200).json({ success: true, message })
    } catch (err: any) {
        console.error('Error al guardar respuesta manual:', err?.response?.data || err.message)
        res.status(500).json({ error: 'Error al guardar el mensaje' })
    }
}

// ——————————————————————————————
// POST responder (si quieres mantener esta variante genérica)
// Igual que arriba: NO pasar conversationId al service.
// ——————————————————————————————
export const postMessageToConversation = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const { contenido } = req.body as { contenido?: string }

    if (!contenido?.trim()) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        await sendOutboundMessage({
            empresaId: conv.empresaId,
            to: conv.phone,
            body: contenido,
            // no conversationId !
        })

        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                empresaId: conv.empresaId,
                from: MessageFrom.agent,
                contenido,
                timestamp: new Date(),
            },
        })

        await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: ConversationEstado.respondido },
        })

        const io = getIO(req)
        io?.emit?.('nuevo_mensaje', {
            conversationId: conv.id,
            message,
        })

        res.status(201).json({ message })
    } catch (error: any) {
        console.error(error?.response?.data || error)
        res.status(500).json({ error: 'Error al enviar o guardar el mensaje' })
    }
}

// ——————————————————————————————
// POST iniciar chat con plantilla (fuera de 24h)
// Usa sendTemplate (tu service ya lo expone).
// ——————————————————————————————
export const iniciarChat = async (req: Request, res: Response) => {
    try {
        const {
            conversationId,
            empresaId,
            to,
            templateName,
            templateLang,
            variables = [],
        } = req.body as {
            conversationId?: number
            empresaId: number
            to: string
            templateName?: string
            templateLang?: string
            variables?: string[]
        }

        if (!templateName || !templateLang) {
            return res.status(409).json({
                ok: false,
                reason: 'template_required',
                message: 'Para iniciar conversaciones fuera de 24h necesitas una plantilla aprobada.',
            })
        }

        let convId = conversationId
        if (!convId) {
            const conv = await prisma.conversation.create({
                data: { empresaId, phone: to, estado: ConversationEstado.pendiente },
            })
            convId = conv.id
        }

        const result = await sendTemplate({
            empresaId,
            to,
            templateName,
            templateLang,
            variables,
        })

        return res.json({ ok: true, conversationId: convId, result })
    } catch (error: any) {
        const msg = error?.response?.data || error?.message || error
        if (error?.status === 409 || /OUT_OF_24H_WINDOW/i.test(String(msg))) {
            return res.status(409).json({
                ok: false,
                reason: 'out_of_24h',
                message: 'La ventana de 24h está cerrada; usa una plantilla para responder.',
            })
        }
        console.error('[iniciarChat] error:', msg)
        return res.status(500).json({ ok: false, message: 'Error iniciando chat con plantilla' })
    }
}

// ——————————————————————————————
// IA (sin cambios de tipos)
// ——————————————————————————————
export const responderConIA = async (req: Request, res: Response) => {
    const { chatId, mensaje, intentosFallidos = 0 } = req.body as {
        chatId: number
        mensaje: string
        intentosFallidos?: number
    }
    const empresaId = (req as any).user?.empresaId

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(chatId) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para responder esta conversación' })
        }

        const result = await handleIAReply(chatId, mensaje)
        if (!result) return res.status(400).json({ error: 'No se pudo generar respuesta con IA' })

        if (result.estado === ConversationEstado.requiere_agente) {
            return res.json({
                estado: ConversationEstado.requiere_agente,
                mensaje: 'Chat marcado como requiere atención humana',
            })
        }

        return res.json({ mensaje: result.mensaje })
    } catch (err) {
        console.error('Error al responder con IA:', err)
        return res.status(500).json({ error: 'Error al procesar respuesta de IA' })
    }
}

// ——————————————————————————————
// Cambiar estado conversación
// ——————————————————————————————
export const updateConversationEstado = async (req: Request, res: Response) => {
    const { id } = req.params
    const { estado } = req.body as { estado: ConversationEstado }
    const empresaId = (req as any).user?.empresaId

    if (!estado || !Object.values(ConversationEstado).includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' })
    }

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para modificar esta conversación' })
        }

        const updated = await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado },
        })

        return res.json({ success: true, estado: updated.estado })
    } catch (err) {
        console.error('❌ Error actualizando estado:', err)
        return res.status(500).json({ error: 'Error actualizando estado de la conversación' })
    }
}

// ——————————————————————————————
// Cerrar conversación
// ——————————————————————————————
export const cerrarConversacion = async (req: Request, res: Response) => {
    const { id } = req.params
    const empresaId = (req as any).user?.empresaId

    try {
        const conv = await prisma.conversation.findUnique({ where: { id: Number(id) } })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: 'No autorizado para cerrar esta conversación' })
        }

        const updated = await prisma.conversation.update({
            where: { id: conv.id },
            data: { estado: ConversationEstado.cerrado },
        })

        const io = getIO(req)
        io?.emit?.('chat_actualizado', { id: updated.id, estado: updated.estado })

        res.status(200).json({ success: true })
    } catch (err) {
        console.error('Error al cerrar conversación:', err)
        res.status(500).json({ error: 'No se pudo cerrar la conversación' })
    }
}

// ——————————————————————————————
// Crear conversación (desde dashboard)
// ——————————————————————————————
export const crearConversacion = async (req: Request, res: Response) => {
    const { phone, nombre } = req.body as { phone?: string; nombre?: string }
    const empresaId = (req as any).user?.empresaId

    if (!empresaId) return res.status(401).json({ error: 'No autorizado' })
    if (!phone?.trim()) return res.status(400).json({ error: 'El número de teléfono es obligatorio' })

    try {
        const nueva = await prisma.conversation.create({
            data: {
                phone,
                nombre: nombre?.trim() || null,
                estado: ConversationEstado.pendiente,
                empresaId,
            },
        })

        // Opcional: emite a la lista de chats si quieres que aparezca en tiempo real
        const io = req.app.get('io')
        io?.emit?.('chat_actualizado', { id: nueva.id, estado: nueva.estado })

        return res.status(201).json({ message: 'Conversación creada', chat: nueva })
    } catch (err) {
        console.error('[crearConversacion] Error:', err)
        return res.status(500).json({ error: 'Error al crear la conversación' })
    }
}

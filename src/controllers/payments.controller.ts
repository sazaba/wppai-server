// server/src/controllers/payments.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"
import { ConversationEstado } from "@prisma/client"

const asNum = (v: any) => {
    if (v === undefined || v === null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}

function ensureOwned<T extends { empresaId: number }>(obj: T | null, empresaId: number) {
    if (!obj || obj.empresaId !== empresaId) {
        const e: any = new Error("Not found or not allowed")
        e.status = 404
        throw e
    }
}

/**
 * GET /api/payments?orderId=
 */
export async function listPayments(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const orderId = req.query.orderId ? Number(req.query.orderId) : null

    try {
        const where: any = {}
        if (orderId) where.orderId = orderId

        const list = await prisma.paymentReceipt.findMany({
            where,
            orderBy: { id: "desc" },
        })

        // validar pertenencia si se filtró por orderId
        if (orderId) {
            const order = await prisma.order.findUnique({ where: { id: orderId } })
            ensureOwned(order, empresaId)
        } else {
            // Si no hay filtro, devolvemos solo pagos de órdenes de la empresa
            const orders = await prisma.order.findMany({ where: { empresaId }, select: { id: true } })
            const ids = new Set(orders.map(o => o.id))
            return res.json(list.filter(p => ids.has(p.orderId)))
        }

        return res.json(list)
    } catch (error) {
        console.error("[listPayments] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudieron listar los pagos" })
    }
}

/**
 * GET /api/payments/:id
 */
export async function getPayment(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)

    try {
        const pay = await prisma.paymentReceipt.findUnique({ where: { id } })
        if (!pay) return res.status(404).json({ error: "No encontrado" })

        const order = await prisma.order.findUnique({ where: { id: pay.orderId } })
        ensureOwned(order, empresaId)

        return res.json(pay)
    } catch (error) {
        console.error("[getPayment] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo obtener el pago" })
    }
}

/**
 * POST /api/payments/receipt
 * body: { orderId, messageId?, imageUrl, amount?, reference?, method?, rawOcrText? }
 */
export async function createPaymentReceipt(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const { orderId, messageId, imageUrl, amount, reference, method, rawOcrText } = req.body || {}

    if (!orderId || !imageUrl) {
        return res.status(400).json({ error: "orderId e imageUrl son requeridos" })
    }

    try {
        const order = await prisma.order.findUnique({ where: { id: Number(orderId) } })
        ensureOwned(order, empresaId)

        const pay = await prisma.paymentReceipt.create({
            data: {
                orderId: Number(orderId),
                messageId: messageId ? Number(messageId) : null,
                imageUrl: String(imageUrl),
                amount: asNum(amount) ?? null,
                reference: String(reference || ""),
                method: String(method || ""),
                rawOcrText: String(rawOcrText || ""),
            },
        })

        // marcar conversación como venta_en_proceso si no lo está
        const conv = await prisma.conversation.findUnique({ where: { id: order!.conversationId } })
        if (conv && conv.estado !== ConversationEstado.venta_en_proceso && conv.estado !== ConversationEstado.venta_realizada) {
            await prisma.conversation.update({
                where: { id: conv.id },
                data: { estado: ConversationEstado.venta_en_proceso },
            })
        }

        return res.json(pay)
    } catch (error) {
        console.error("[createPaymentReceipt] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo crear el comprobante" })
    }
}

/**
 * POST /api/payments/:id/verify
 * body: { isVerified: boolean, verifiedAt?: string, amount?: number, reference?: string }
 * Si isVerified=true => order.status="paid" y Conversation.estado = venta_realizada
 */
export async function verifyPayment(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    const { isVerified, verifiedAt, amount, reference } = req.body || {}

    try {
        const pay = await prisma.paymentReceipt.findUnique({ where: { id } })
        if (!pay) return res.status(404).json({ error: "Pago no encontrado" })

        const order = await prisma.order.findUnique({ where: { id: pay.orderId } })
        ensureOwned(order, empresaId)

        const updatedPay = await prisma.paymentReceipt.update({
            where: { id },
            data: {
                isVerified: Boolean(isVerified),
                verifiedAt: Boolean(isVerified) ? (verifiedAt ? new Date(verifiedAt) : new Date()) : null,
                amount: asNum(amount) ?? pay.amount,
                reference: reference !== undefined ? String(reference) : pay.reference,
            },
        })

        if (Boolean(isVerified)) {
            await prisma.order.update({ where: { id: order!.id }, data: { status: "paid" } })
            await prisma.conversation.update({
                where: { id: order!.conversationId },
                data: { estado: ConversationEstado.venta_realizada },
            })
        }

        return res.json(updatedPay)
    } catch (error) {
        console.error("[verifyPayment] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo verificar el pago" })
    }
}

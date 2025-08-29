// server/src/controllers/orders.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"
import { ConversationEstado } from "@prisma/client"

const asNum = (v: any) => {
    if (v === undefined || v === null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}

async function recalcTotals(orderId: number) {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true, Conversation: true },
    })
    if (!order) throw new Error("Order not found")

    const empresaId = order.empresaId
    const cfg = await prisma.businessConfig.findUnique({ where: { empresaId } })

    const subtotal = order.items.reduce((acc, it) => acc + Number(it.total || 0), 0)

    // Regla de envío:
    // - Si hay envioGratisDesde y subtotal >= umbral => shipping 0
    // - Si hay envioCostoFijo => aplica
    // - Si no hay ninguna => 0
    let shippingCost = 0
    const costoFijo = cfg?.envioCostoFijo != null ? Number(cfg.envioCostoFijo) : null
    const gratisDesde = cfg?.envioGratisDesde != null ? Number(cfg.envioGratisDesde) : null

    if (gratisDesde != null && subtotal >= gratisDesde) {
        shippingCost = 0
    } else if (costoFijo != null) {
        shippingCost = costoFijo
    } else {
        shippingCost = 0
    }

    const total = subtotal + shippingCost

    return prisma.order.update({
        where: { id: orderId },
        data: {
            subtotal,
            shippingCost,
            total,
        },
    })
}

function ensureOwned<T extends { empresaId: number }>(obj: T | null, empresaId: number) {
    if (!obj || obj.empresaId !== empresaId) {
        const e: any = new Error("Not found or not allowed")
        e.status = 404
        throw e
    }
}

/**
 * POST /api/orders/from-conversation/:conversationId
 * Crea o retorna el pedido "pending" asociado a la conversación
 */
export async function createOrResumeFromConversation(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const conversationId = Number(req.params.conversationId)

    try {
        const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, empresaId: true, phone: true, estado: true },
        })
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(404).json({ error: "Conversación no encontrada" })
        }

        // ¿Ya existe un pedido pending?
        let order = await prisma.order.findFirst({
            where: { empresaId, conversationId, status: "pending" },
            include: { items: true },
            orderBy: { id: "desc" },
        })

        if (!order) {
            order = await prisma.order.create({
                data: {
                    empresaId,
                    conversationId,
                    customerPhone: conv.phone,
                    status: "pending",
                    subtotal: 0,
                    shippingCost: 0,
                    total: 0,
                    notes: "",
                },
                include: { items: true },
            })
        }

        // Mover conversación a "venta_en_proceso"
        if (conv.estado !== ConversationEstado.venta_en_proceso) {
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { estado: ConversationEstado.venta_en_proceso },
            })
        }

        // recalcular totales por si acaso (sin items = 0)
        const updated = await recalcTotals(order.id)
        return res.json(updated)
    } catch (error) {
        console.error("[createOrResumeFromConversation] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo crear/retomar el pedido" })
    }
}

/**
 * GET /api/orders
 * Lista órdenes de la empresa (con filtros opcionales: status, conversationId)
 */
export async function listOrders(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const { status, conversationId } = req.query

    try {
        const where: any = { empresaId }
        if (status) where.status = String(status)
        if (conversationId) where.conversationId = Number(conversationId)

        const list = await prisma.order.findMany({
            where,
            orderBy: { id: "desc" },
            include: {
                items: true,
                payments: true,
                Conversation: { select: { phone: true, estado: true } },
            },
        })
        return res.json(list)
    } catch (error) {
        console.error("[listOrders] error:", error)
        return res.status(500).json({ error: "No se pudieron listar los pedidos" })
    }
}

/**
 * GET /api/orders/:id
 */
export async function getOrder(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)

    try {
        const order = await prisma.order.findUnique({
            where: { id },
            include: { items: true, payments: true, Conversation: true },
        })
        ensureOwned(order, empresaId)
        return res.json(order)
    } catch (error) {
        console.error("[getOrder] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo obtener el pedido" })
    }
}

/**
 * PUT /api/orders/:id
 * Actualiza datos del pedido (cliente, dirección, notas, status)
 */
export async function updateOrder(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)

    const {
        customerName,
        customerPhone,
        city,
        address,
        notes,
        status, // "pending"|"paid"|"shipped"|"delivered"|"canceled"
        shippingCost, // opcional override manual
    } = req.body || {}

    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        const updated = await prisma.order.update({
            where: { id },
            data: {
                customerName: customerName ?? order!.customerName,
                customerPhone: customerPhone ?? order!.customerPhone,
                city: city ?? order!.city,
                address: address ?? order!.address,
                notes: notes ?? order!.notes,
                status: status ?? order!.status,
                shippingCost: asNum(shippingCost) ?? order!.shippingCost,
            },
        })

        // si tocamos ítems fuera, recalc; si solo tocamos datos superficiales y shipping, recalculamos total
        const final = await recalcTotals(updated.id)

        // Sincronizar estado de conversación en pagos clave
        if (status === "paid") {
            await prisma.conversation.update({
                where: { id: updated.conversationId },
                data: { estado: ConversationEstado.venta_realizada },
            })
        } else if (status === "pending") {
            await prisma.conversation.update({
                where: { id: updated.conversationId },
                data: { estado: ConversationEstado.venta_en_proceso },
            })
        }

        return res.json(final)
    } catch (error) {
        console.error("[updateOrder] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo actualizar el pedido" })
    }
}

/**
 * DELETE /api/orders/:id
 */
export async function deleteOrder(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)

    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        await prisma.order.delete({ where: { id } })
        return res.json({ ok: true })
    } catch (error) {
        console.error("[deleteOrder] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo eliminar el pedido" })
    }
}

/**
 * POST /api/orders/:id/items
 * body: { productId, qty?, price? }
 */
export async function addItem(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    const { productId, qty, price } = req.body || {}

    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        const prod = await prisma.product.findUnique({ where: { id: Number(productId) } })
        if (!prod || prod.empresaId !== empresaId) {
            return res.status(404).json({ error: "Producto no encontrado" })
        }

        const q = Number(qty ?? 1)
        const pUnit = asNum(price) ?? (prod.precioDesde != null ? Number(prod.precioDesde) : 0)
        const total = pUnit * q

        await prisma.orderItem.create({
            data: {
                orderId: id,
                productId: prod.id,
                name: prod.nombre,
                price: pUnit,
                qty: q,
                total,
            },
        })

        const final = await recalcTotals(id)
        return res.json(final)
    } catch (error) {
        console.error("[addItem] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo agregar el ítem" })
    }
}

/**
 * PUT /api/orders/:id/items/:itemId
 * body: { qty?, price? }
 */
export async function updateItem(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    const itemId = Number(req.params.itemId)
    const { qty, price } = req.body || {}

    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        const item = await prisma.orderItem.findUnique({ where: { id: itemId } })
        if (!item || item.orderId !== id) {
            return res.status(404).json({ error: "Item no encontrado" })
        }

        const q = Number(qty ?? item.qty)
        const p = asNum(price) ?? Number(item.price)
        const total = p * q

        await prisma.orderItem.update({
            where: { id: itemId },
            data: { qty: q, price: p, total },
        })

        const final = await recalcTotals(id)
        return res.json(final)
    } catch (error) {
        console.error("[updateItem] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo actualizar el ítem" })
    }
}

/**
 * DELETE /api/orders/:id/items/:itemId
 */
export async function deleteItem(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    const itemId = Number(req.params.itemId)

    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        const item = await prisma.orderItem.findUnique({ where: { id: itemId } })
        if (!item || item.orderId !== id) {
            return res.status(404).json({ error: "Item no encontrado" })
        }

        await prisma.orderItem.delete({ where: { id: itemId } })
        const final = await recalcTotals(id)
        return res.json(final)
    } catch (error) {
        console.error("[deleteItem] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo eliminar el ítem" })
    }
}

/**
 * POST /api/orders/:id/recalc
 * Fuerza recálculo de totales (útil si cambiaste config de envío)
 */
export async function forceRecalc(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)
        const final = await recalcTotals(id)
        return res.json(final)
    } catch (error) {
        console.error("[forceRecalc] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo recalcular" })
    }
}

/**
 * POST /api/orders/:id/advance
 * Avanza el estado de la conversación a venta_en_proceso (por si quedó en otro)
 */
export async function ensureVentaEnProceso(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    try {
        const order = await prisma.order.findUnique({ where: { id } })
        ensureOwned(order, empresaId)

        await prisma.conversation.update({
            where: { id: order!.conversationId },
            data: { estado: ConversationEstado.venta_en_proceso },
        })
        return res.json({ ok: true })
    } catch (error) {
        console.error("[ensureVentaEnProceso] error:", error)
        return res.status((error as any).status || 500).json({ error: "No se pudo actualizar la conversación" })
    }
}

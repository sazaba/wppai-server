"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrResumeFromConversation = createOrResumeFromConversation;
exports.listOrders = listOrders;
exports.getOrder = getOrder;
exports.updateOrder = updateOrder;
exports.deleteOrder = deleteOrder;
exports.addItem = addItem;
exports.updateItem = updateItem;
exports.deleteItem = deleteItem;
exports.forceRecalc = forceRecalc;
exports.ensureVentaEnProceso = ensureVentaEnProceso;
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const asNum = (v) => {
    if (v === undefined || v === null || v === "")
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
async function recalcTotals(orderId) {
    const order = await prisma_1.default.order.findUnique({
        where: { id: orderId },
        include: { items: true, Conversation: true },
    });
    if (!order)
        throw new Error("Order not found");
    const empresaId = order.empresaId;
    const cfg = await prisma_1.default.businessConfig.findUnique({ where: { empresaId } });
    const subtotal = order.items.reduce((acc, it) => acc + Number(it.total || 0), 0);
    // Regla de envío:
    // - Si hay envioGratisDesde y subtotal >= umbral => shipping 0
    // - Si hay envioCostoFijo => aplica
    // - Si no hay ninguna => 0
    let shippingCost = 0;
    const costoFijo = cfg?.envioCostoFijo != null ? Number(cfg.envioCostoFijo) : null;
    const gratisDesde = cfg?.envioGratisDesde != null ? Number(cfg.envioGratisDesde) : null;
    if (gratisDesde != null && subtotal >= gratisDesde) {
        shippingCost = 0;
    }
    else if (costoFijo != null) {
        shippingCost = costoFijo;
    }
    else {
        shippingCost = 0;
    }
    const total = subtotal + shippingCost;
    return prisma_1.default.order.update({
        where: { id: orderId },
        data: {
            subtotal,
            shippingCost,
            total,
        },
    });
}
function ensureOwned(obj, empresaId) {
    if (!obj || obj.empresaId !== empresaId) {
        const e = new Error("Not found or not allowed");
        e.status = 404;
        throw e;
    }
}
/**
 * POST /api/orders/from-conversation/:conversationId
 * Crea o retorna el pedido "pending" asociado a la conversación
 */
async function createOrResumeFromConversation(req, res) {
    const empresaId = req.user?.empresaId;
    const conversationId = Number(req.params.conversationId);
    try {
        const conv = await prisma_1.default.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, empresaId: true, phone: true, estado: true },
        });
        if (!conv || conv.empresaId !== empresaId) {
            return res.status(404).json({ error: "Conversación no encontrada" });
        }
        // ¿Ya existe un pedido pending?
        let order = await prisma_1.default.order.findFirst({
            where: { empresaId, conversationId, status: "pending" },
            include: { items: true },
            orderBy: { id: "desc" },
        });
        if (!order) {
            order = await prisma_1.default.order.create({
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
            });
        }
        // Mover conversación a "venta_en_proceso"
        if (conv.estado !== client_1.ConversationEstado.venta_en_proceso) {
            await prisma_1.default.conversation.update({
                where: { id: conversationId },
                data: { estado: client_1.ConversationEstado.venta_en_proceso },
            });
        }
        // recalcular totales por si acaso (sin items = 0)
        const updated = await recalcTotals(order.id);
        return res.json(updated);
    }
    catch (error) {
        console.error("[createOrResumeFromConversation] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo crear/retomar el pedido" });
    }
}
/**
 * GET /api/orders
 * Lista órdenes de la empresa (con filtros opcionales: status, conversationId)
 */
async function listOrders(req, res) {
    const empresaId = req.user?.empresaId;
    const { status, conversationId } = req.query;
    try {
        const where = { empresaId };
        if (status)
            where.status = String(status);
        if (conversationId)
            where.conversationId = Number(conversationId);
        const list = await prisma_1.default.order.findMany({
            where,
            orderBy: { id: "desc" },
            include: {
                items: true,
                payments: true,
                Conversation: { select: { phone: true, estado: true } },
            },
        });
        return res.json(list);
    }
    catch (error) {
        console.error("[listOrders] error:", error);
        return res.status(500).json({ error: "No se pudieron listar los pedidos" });
    }
}
/**
 * GET /api/orders/:id
 */
async function getOrder(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const order = await prisma_1.default.order.findUnique({
            where: { id },
            include: { items: true, payments: true, Conversation: true },
        });
        ensureOwned(order, empresaId);
        return res.json(order);
    }
    catch (error) {
        console.error("[getOrder] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo obtener el pedido" });
    }
}
/**
 * PUT /api/orders/:id
 * Actualiza datos del pedido (cliente, dirección, notas, status)
 */
async function updateOrder(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    const { customerName, customerPhone, city, address, notes, status, // "pending"|"paid"|"shipped"|"delivered"|"canceled"
    shippingCost, // opcional override manual
     } = req.body || {};
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        const updated = await prisma_1.default.order.update({
            where: { id },
            data: {
                customerName: customerName ?? order.customerName,
                customerPhone: customerPhone ?? order.customerPhone,
                city: city ?? order.city,
                address: address ?? order.address,
                notes: notes ?? order.notes,
                status: status ?? order.status,
                shippingCost: asNum(shippingCost) ?? order.shippingCost,
            },
        });
        // si tocamos ítems fuera, recalc; si solo tocamos datos superficiales y shipping, recalculamos total
        const final = await recalcTotals(updated.id);
        // Sincronizar estado de conversación en pagos clave
        if (status === "paid") {
            await prisma_1.default.conversation.update({
                where: { id: updated.conversationId },
                data: { estado: client_1.ConversationEstado.venta_realizada },
            });
        }
        else if (status === "pending") {
            await prisma_1.default.conversation.update({
                where: { id: updated.conversationId },
                data: { estado: client_1.ConversationEstado.venta_en_proceso },
            });
        }
        return res.json(final);
    }
    catch (error) {
        console.error("[updateOrder] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo actualizar el pedido" });
    }
}
/**
 * DELETE /api/orders/:id
 */
async function deleteOrder(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        await prisma_1.default.order.delete({ where: { id } });
        return res.json({ ok: true });
    }
    catch (error) {
        console.error("[deleteOrder] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo eliminar el pedido" });
    }
}
/**
 * POST /api/orders/:id/items
 * body: { productId, qty?, price? }
 */
async function addItem(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    const { productId, qty, price } = req.body || {};
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        const prod = await prisma_1.default.product.findUnique({ where: { id: Number(productId) } });
        if (!prod || prod.empresaId !== empresaId) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }
        const q = Number(qty ?? 1);
        const pUnit = asNum(price) ?? (prod.precioDesde != null ? Number(prod.precioDesde) : 0);
        const total = pUnit * q;
        await prisma_1.default.orderItem.create({
            data: {
                orderId: id,
                productId: prod.id,
                name: prod.nombre,
                price: pUnit,
                qty: q,
                total,
            },
        });
        const final = await recalcTotals(id);
        return res.json(final);
    }
    catch (error) {
        console.error("[addItem] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo agregar el ítem" });
    }
}
/**
 * PUT /api/orders/:id/items/:itemId
 * body: { qty?, price? }
 */
async function updateItem(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const { qty, price } = req.body || {};
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        const item = await prisma_1.default.orderItem.findUnique({ where: { id: itemId } });
        if (!item || item.orderId !== id) {
            return res.status(404).json({ error: "Item no encontrado" });
        }
        const q = Number(qty ?? item.qty);
        const p = asNum(price) ?? Number(item.price);
        const total = p * q;
        await prisma_1.default.orderItem.update({
            where: { id: itemId },
            data: { qty: q, price: p, total },
        });
        const final = await recalcTotals(id);
        return res.json(final);
    }
    catch (error) {
        console.error("[updateItem] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo actualizar el ítem" });
    }
}
/**
 * DELETE /api/orders/:id/items/:itemId
 */
async function deleteItem(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        const item = await prisma_1.default.orderItem.findUnique({ where: { id: itemId } });
        if (!item || item.orderId !== id) {
            return res.status(404).json({ error: "Item no encontrado" });
        }
        await prisma_1.default.orderItem.delete({ where: { id: itemId } });
        const final = await recalcTotals(id);
        return res.json(final);
    }
    catch (error) {
        console.error("[deleteItem] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo eliminar el ítem" });
    }
}
/**
 * POST /api/orders/:id/recalc
 * Fuerza recálculo de totales (útil si cambiaste config de envío)
 */
async function forceRecalc(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        const final = await recalcTotals(id);
        return res.json(final);
    }
    catch (error) {
        console.error("[forceRecalc] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo recalcular" });
    }
}
/**
 * POST /api/orders/:id/advance
 * Avanza el estado de la conversación a venta_en_proceso (por si quedó en otro)
 */
async function ensureVentaEnProceso(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id } });
        ensureOwned(order, empresaId);
        await prisma_1.default.conversation.update({
            where: { id: order.conversationId },
            data: { estado: client_1.ConversationEstado.venta_en_proceso },
        });
        return res.json({ ok: true });
    }
    catch (error) {
        console.error("[ensureVentaEnProceso] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo actualizar la conversación" });
    }
}

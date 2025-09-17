"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPayments = listPayments;
exports.getPayment = getPayment;
exports.createPaymentReceipt = createPaymentReceipt;
exports.verifyPayment = verifyPayment;
const prisma_1 = __importDefault(require("../lib/prisma"));
const client_1 = require("@prisma/client");
const asNum = (v) => {
    if (v === undefined || v === null || v === "")
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
function ensureOwned(obj, empresaId) {
    if (!obj || obj.empresaId !== empresaId) {
        const e = new Error("Not found or not allowed");
        e.status = 404;
        throw e;
    }
}
/**
 * GET /api/payments?orderId=
 */
async function listPayments(req, res) {
    const empresaId = req.user?.empresaId;
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;
    try {
        const where = {};
        if (orderId)
            where.orderId = orderId;
        const list = await prisma_1.default.paymentReceipt.findMany({
            where,
            orderBy: { id: "desc" },
        });
        // validar pertenencia si se filtró por orderId
        if (orderId) {
            const order = await prisma_1.default.order.findUnique({ where: { id: orderId } });
            ensureOwned(order, empresaId);
        }
        else {
            // Si no hay filtro, devolvemos solo pagos de órdenes de la empresa
            const orders = await prisma_1.default.order.findMany({ where: { empresaId }, select: { id: true } });
            const ids = new Set(orders.map(o => o.id));
            return res.json(list.filter(p => ids.has(p.orderId)));
        }
        return res.json(list);
    }
    catch (error) {
        console.error("[listPayments] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudieron listar los pagos" });
    }
}
/**
 * GET /api/payments/:id
 */
async function getPayment(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const pay = await prisma_1.default.paymentReceipt.findUnique({ where: { id } });
        if (!pay)
            return res.status(404).json({ error: "No encontrado" });
        const order = await prisma_1.default.order.findUnique({ where: { id: pay.orderId } });
        ensureOwned(order, empresaId);
        return res.json(pay);
    }
    catch (error) {
        console.error("[getPayment] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo obtener el pago" });
    }
}
/**
 * POST /api/payments/receipt
 * body: { orderId, messageId?, imageUrl, amount?, reference?, method?, rawOcrText? }
 */
async function createPaymentReceipt(req, res) {
    const empresaId = req.user?.empresaId;
    const { orderId, messageId, imageUrl, amount, reference, method, rawOcrText } = req.body || {};
    if (!orderId || !imageUrl) {
        return res.status(400).json({ error: "orderId e imageUrl son requeridos" });
    }
    try {
        const order = await prisma_1.default.order.findUnique({ where: { id: Number(orderId) } });
        ensureOwned(order, empresaId);
        const pay = await prisma_1.default.paymentReceipt.create({
            data: {
                orderId: Number(orderId),
                messageId: messageId ? Number(messageId) : null,
                imageUrl: String(imageUrl),
                amount: asNum(amount) ?? null,
                reference: String(reference || ""),
                method: String(method || ""),
                rawOcrText: String(rawOcrText || ""),
            },
        });
        // marcar conversación como venta_en_proceso si no lo está
        const conv = await prisma_1.default.conversation.findUnique({ where: { id: order.conversationId } });
        if (conv && conv.estado !== client_1.ConversationEstado.venta_en_proceso && conv.estado !== client_1.ConversationEstado.venta_realizada) {
            await prisma_1.default.conversation.update({
                where: { id: conv.id },
                data: { estado: client_1.ConversationEstado.venta_en_proceso },
            });
        }
        return res.json(pay);
    }
    catch (error) {
        console.error("[createPaymentReceipt] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo crear el comprobante" });
    }
}
/**
 * POST /api/payments/:id/verify
 * body: { isVerified: boolean, verifiedAt?: string, amount?: number, reference?: string }
 * Si isVerified=true => order.status="paid" y Conversation.estado = venta_realizada
 */
async function verifyPayment(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    const { isVerified, verifiedAt, amount, reference } = req.body || {};
    try {
        const pay = await prisma_1.default.paymentReceipt.findUnique({ where: { id } });
        if (!pay)
            return res.status(404).json({ error: "Pago no encontrado" });
        const order = await prisma_1.default.order.findUnique({ where: { id: pay.orderId } });
        ensureOwned(order, empresaId);
        const updatedPay = await prisma_1.default.paymentReceipt.update({
            where: { id },
            data: {
                isVerified: Boolean(isVerified),
                verifiedAt: Boolean(isVerified) ? (verifiedAt ? new Date(verifiedAt) : new Date()) : null,
                amount: asNum(amount) ?? pay.amount,
                reference: reference !== undefined ? String(reference) : pay.reference,
            },
        });
        if (Boolean(isVerified)) {
            await prisma_1.default.order.update({ where: { id: order.id }, data: { status: "paid" } });
            await prisma_1.default.conversation.update({
                where: { id: order.conversationId },
                data: { estado: client_1.ConversationEstado.venta_realizada },
            });
        }
        return res.json(updatedPay);
    }
    catch (error) {
        console.error("[verifyPayment] error:", error);
        return res.status(error.status || 500).json({ error: "No se pudo verificar el pago" });
    }
}

// server/controllers/chatInput.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";

/* ============================================================
   ChatInput Controller — Endpoints dedicados al modal de cita
   ============================================================ */

/**
 * GET /api/chat-input/state/:conversationId
 * Devuelve el estado conversacional (draft, summary, phone)
 * que el ChatInput usa para autocompletar nombre, servicio, etc.
 */
export const getChatInputState = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId;
    const conversationId = Number(req.params.conversationId);

    if (!empresaId || !conversationId) {
        return res.status(400).json({ error: "empresaId y conversationId requeridos" });
    }

    try {
        const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
        });

        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: "No autorizado" });
        }

        // Cargamos el último estado conversacional si existe
        const cs: any = await prisma.conversationState.findFirst({
            where: { conversationId },
            orderBy: { createdAt: "desc" },
        }).catch(() => null);

        const state =
            cs?.state ??
            cs?.data ??
            cs?.json ??
            null;

        const summaryText =
            cs?.summary?.text ??
            cs?.summaryText ??
            cs?.text ??
            null;

        return res.json({
            data: state, // aquí debe venir draft.{name, procedureName, ...}
            phone: conv.phone,
            summary: summaryText ? { text: summaryText } : null,
            conversation: {
                id: conv.id,
                phone: conv.phone,
                nombre: conv.nombre,
                estado: conv.estado,
            },
        });
    } catch (err) {
        console.error("[getChatInputState] error:", err);
        return res.status(500).json({ error: "Error obteniendo estado de conversación" });
    }
};

/**
 * GET /api/chat-input/meta/:conversationId
 * Devuelve metadatos de la conversación (nombre, teléfono, summary).
 */
export const getChatInputMeta = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId;
    const conversationId = Number(req.params.conversationId);

    if (!empresaId || !conversationId) {
        return res.status(400).json({ error: "empresaId y conversationId requeridos" });
    }

    try {
        const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
        });

        if (!conv || conv.empresaId !== empresaId) {
            return res.status(403).json({ error: "No autorizado" });
        }

        // Intentamos buscar summary asociado (por si lo guardas en conversationState)
        const cs: any = await prisma.conversationState.findFirst({
            where: { conversationId },
            orderBy: { createdAt: "desc" },
        }).catch(() => null);

        const summaryText =
            cs?.summary?.text ??
            cs?.summaryText ??
            cs?.text ??
            null;

        return res.json({
            id: conv.id,
            phone: conv.phone,
            nombre: conv.nombre,
            estado: conv.estado,
            summary: summaryText ? { text: summaryText } : null,
        });
    } catch (err) {
        console.error("[getChatInputMeta] error:", err);
        return res.status(500).json({ error: "Error obteniendo metadatos de conversación" });
    }
};

/**
 * GET /api/chat-input/staff
 * Devuelve el listado de profesionales (staff) activos
 * para llenar el dropdown del ChatInput.
 */
export const getChatInputStaff = async (req: Request, res: Response) => {
    const empresaId = (req as any).user?.empresaId;

    if (!empresaId) {
        return res.status(400).json({ error: "empresaId requerido" });
    }

    try {
        const data = await prisma.staff.findMany({
            where: { empresaId, active: true },
            orderBy: { name: "asc" },
            select: { id: true, name: true, role: true },
        });

        return res.json({ ok: true, data });
    } catch (err) {
        console.error("[getChatInputStaff] error:", err);
        return res.status(500).json({ error: "Error obteniendo staff" });
    }
};

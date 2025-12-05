import { Request, Response } from "express";
import prisma from "../lib/prisma";

// 👇 DEFINICIÓN CORRECTA: Coincide con tu auth.controller.ts
interface UserPayload {
    id: number;
    email: string;
    rol: string;      // Agregado para que no falle TypeScript
    empresaId: number;
}

// Extendemos Request usando el Payload correcto
interface AuthRequest extends Request {
    user?: UserPayload;
}

// ───────────────────────────────────────────────────────────────────────────────
// Crear registro
// ───────────────────────────────────────────────────────────────────────────────
export const crearTest = async (req: AuthRequest, res: Response) => {
    try {
        const { nombre } = req.body;
        // Ahora TypeScript sabe que user tiene la estructura correcta
        const empresaId = req.user?.empresaId;

        if (!empresaId) return res.status(401).json({ error: "Unauthorized" });
        if (!nombre) return res.status(400).json({ error: "Falta el nombre" });

        const creado = await prisma.testModel.create({
            data: {
                nombre,
                empresaId
            }
        });

        return res.status(201).json(creado);
    } catch (error) {
        console.error("❌ Error al crear test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Listar registros
// ───────────────────────────────────────────────────────────────────────────────
export const listarTests = async (req: AuthRequest, res: Response) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId) return res.status(401).json({ error: "Unauthorized" });

        const lista = await prisma.testModel.findMany({
            where: { empresaId },
            orderBy: { id: "desc" }
        });

        return res.json(lista);
    } catch (error) {
        console.error("❌ Error al listar tests:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Obtener uno
// ───────────────────────────────────────────────────────────────────────────────
export const obtenerTest = async (req: AuthRequest, res: Response) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId) return res.status(401).json({ error: "Unauthorized" });

        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });

        const registro = await prisma.testModel.findFirst({
            where: { id, empresaId }
        });

        if (!registro) return res.status(404).json({ error: "No encontrado" });

        return res.json(registro);
    } catch (error) {
        console.error("❌ Error al obtener test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Eliminar registro
// ───────────────────────────────────────────────────────────────────────────────
export const eliminarTest = async (req: AuthRequest, res: Response) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId) return res.status(401).json({ error: "Unauthorized" });

        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });

        const existente = await prisma.testModel.findFirst({ where: { id, empresaId } });
        if (!existente) return res.status(404).json({ error: "Registro no encontrado" });

        // 👇 Si sigue saliendo error aquí, lee el paso 2 abajo
        await prisma.testModel.delete({ where: { id } });

        return res.json({ mensaje: "Eliminado correctamente" });
    } catch (error) {
        console.error("❌ Error al eliminar test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};
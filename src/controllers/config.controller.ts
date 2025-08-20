import { Request, Response } from "express"
import prisma from "../lib/prisma"

// GET /api/config  -> trae la config de la empresa autenticada
export async function getConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    try {
        const cfg = await prisma.businessConfig.findUnique({ where: { empresaId } })
        return res.json(cfg)
    } catch (error) {
        console.error("[getConfig] error:", error)
        return res.status(500).json({ error: "No se pudo obtener la configuración" })
    }
}

// PUT /api/config  -> upsert por empresaId (sin :id)
export async function upsertConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    const {
        nombre = "",
        descripcion = "",
        servicios = "",
        faq = "",
        horarios = "",
        businessType = "servicios", // 'servicios' | 'productos'
        disclaimers = "",
    } = req.body || {}

    // valida mínimos (ajusta si quieres menos estrictos)
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    try {
        const cfg = await prisma.businessConfig.upsert({
            where: { empresaId },
            update: { nombre, descripcion, servicios, faq, horarios, businessType, disclaimers },
            create: { empresaId, nombre, descripcion, servicios, faq, horarios, businessType, disclaimers },
        })
        return res.json(cfg)
    } catch (error) {
        console.error("[upsertConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración" })
    }
}

// GET /api/config/all -> (opcional) todas las configs de esta empresa (aquí devolvería 1)
export async function getAllConfigs(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    try {
        const list = await prisma.businessConfig.findMany({
            where: { empresaId },
            orderBy: { createdAt: "desc" },
        })
        return res.json(list)
    } catch (error) {
        console.error("[getAllConfigs] error:", error)
        return res.status(500).json({ error: "Error al obtener configuraciones" })
    }
}

// DELETE /api/config/:id  -> por si quieres poder borrarla manualmente
export async function deleteConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const id = Number(req.params.id)
    try {
        const existente = await prisma.businessConfig.findUnique({ where: { id } })
        if (!existente || existente.empresaId !== empresaId) {
            return res.status(404).json({ error: "No autorizado para eliminar esta configuración" })
        }
        await prisma.businessConfig.delete({ where: { id } })
        return res.json({ message: "Configuración eliminada" })
    } catch (error) {
        console.error("[deleteConfig] error:", error)
        return res.status(500).json({ error: "No se pudo eliminar la configuración" })
    }
}

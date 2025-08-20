import { Request, Response } from "express"
import prisma from "../lib/prisma"

// GET /api/config
export async function getConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    try {
        // empresaId no es único -> usa findFirst
        const cfg = await prisma.businessConfig.findFirst({ where: { empresaId } })
        return res.json(cfg)
    } catch (error) {
        console.error("[getConfig] error:", error)
        return res.status(500).json({ error: "No se pudo obtener la configuración" })
    }
}

// PUT /api/config
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

    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    try {
        const existente = await prisma.businessConfig.findFirst({ where: { empresaId } })

        let cfg
        if (existente) {
            cfg = await prisma.businessConfig.update({
                where: { id: existente.id },
                data: { nombre, descripcion, servicios, faq, horarios, businessType, disclaimers },
            })
        } else {
            cfg = await prisma.businessConfig.create({
                data: { empresaId, nombre, descripcion, servicios, faq, horarios, businessType, disclaimers },
            })
        }

        return res.json(cfg)
    } catch (error) {
        console.error("[upsertConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración" })
    }
}

// (opcional) GET /api/config/all
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

// DELETE /api/config/:id
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

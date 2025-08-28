// server/src/controllers/config.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"

// GET /api/config
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

// PUT /api/config
export async function upsertConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    const {
        // base
        nombre = "",
        descripcion = "",
        servicios = "",
        faq = "",
        horarios = "",
        businessType = "servicios",
        disclaimers = "",

        // operación
        enviosInfo = "",
        metodosPago = "",
        tiendaFisica = false,
        direccionTienda = "",
        politicasDevolucion = "",
        politicasGarantia = "",
        promocionesInfo = "",
        canalesAtencion = "",
        extras = "",
        palabrasClaveNegocio = "",

        // escalamiento
        escalarSiNoConfia = true,
        escalarPalabrasClave = "",
        escalarPorReintentos = 0,
    } = req.body || {}

    // Reglas mínimas para no guardar vacío del todo
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    try {
        const data = {
            nombre,
            descripcion,
            servicios,
            faq,
            horarios,
            businessType,
            disclaimers,

            enviosInfo,
            metodosPago,
            tiendaFisica: Boolean(tiendaFisica),
            direccionTienda,
            politicasDevolucion,
            politicasGarantia,
            promocionesInfo,
            canalesAtencion,
            extras,
            palabrasClaveNegocio,

            escalarSiNoConfia: Boolean(escalarSiNoConfia),
            escalarPalabrasClave,
            escalarPorReintentos: Number(escalarPorReintentos || 0),
        }

        const existente = await prisma.businessConfig.findUnique({ where: { empresaId } })
        const cfg = existente
            ? await prisma.businessConfig.update({ where: { empresaId }, data })
            : await prisma.businessConfig.create({ data: { empresaId, ...data } })

        return res.json(cfg)
    } catch (error) {
        console.error("[upsertConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración" })
    }
}

// GET /api/config/all (opcional)
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

// DELETE /api/config?withCatalog=1
export async function resetConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const withCatalog = ['1', 'true', 'yes'].includes(String(req.query.withCatalog || '').toLowerCase())

    try {
        await prisma.$transaction(async (tx) => {
            await tx.businessConfig.delete({ where: { empresaId } }).catch(() => { })
            if (withCatalog) {
                await tx.productImage.deleteMany({ where: { product: { empresaId } } })
                await tx.product.deleteMany({ where: { empresaId } })
            }
        })
        return res.json({ ok: true, withCatalog })
    } catch (error) {
        console.error("[resetConfig] error:", error)
        return res.status(500).json({ error: "No se pudo reiniciar la configuración" })
    }
}

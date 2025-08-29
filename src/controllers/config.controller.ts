// server/src/controllers/config.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"

// Helpers de normalización
const s = (v: any, def = "") => (v === undefined || v === null ? def : String(v).trim())
const b = (v: any, def = false) => (v === undefined || v === null ? def : Boolean(v))
const nOrNull = (v: any) => {
    if (v === undefined || v === null || v === "") return null
    const num = Number(v)
    return Number.isFinite(num) ? num : null
}

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

    // Base
    const nombre = s(req.body?.nombre)
    const descripcion = s(req.body?.descripcion)
    const servicios = s(req.body?.servicios)
    const faq = s(req.body?.faq)
    const horarios = s(req.body?.horarios)
    const businessType = s(req.body?.businessType || "servicios")
    const disclaimers = s(req.body?.disclaimers)

    // Operación
    const enviosInfo = s(req.body?.enviosInfo)
    const metodosPago = s(req.body?.metodosPago)
    const tiendaFisica = b(req.body?.tiendaFisica, false)
    const direccionTienda = s(req.body?.direccionTienda)
    const politicasDevolucion = s(req.body?.politicasDevolucion)
    const politicasGarantia = s(req.body?.politicasGarantia)
    const promocionesInfo = s(req.body?.promocionesInfo)
    const canalesAtencion = s(req.body?.canalesAtencion)
    const extras = s(req.body?.extras)
    const palabrasClaveNegocio = s(req.body?.palabrasClaveNegocio)

    // 🔐 Escalamiento
    const escalarSiNoConfia = b(req.body?.escalarSiNoConfia, true)
    const escalarPalabrasClave = s(req.body?.escalarPalabrasClave)
    const escalarPorReintentos = Number(req.body?.escalarPorReintentos ?? 0) || 0

    // 🛒 Ecommerce — pagos (link + transferencia)
    const pagoLinkGenerico = s(req.body?.pagoLinkGenerico)
    const pagoLinkProductoBase = s(req.body?.pagoLinkProductoBase)
    const pagoNotasRaw = req.body?.pagoNotas // puede ser null
    const pagoNotas = (pagoNotasRaw === null) ? null : s(pagoNotasRaw) || null

    const bancoNombre = s(req.body?.bancoNombre)
    const bancoTitular = s(req.body?.bancoTitular)
    const bancoTipoCuenta = s(req.body?.bancoTipoCuenta)
    const bancoNumeroCuenta = s(req.body?.bancoNumeroCuenta)
    const bancoDocumento = s(req.body?.bancoDocumento)
    const transferenciaQRUrl = s(req.body?.transferenciaQRUrl)

    // 🚚 Envío
    const envioTipo = s(req.body?.envioTipo)
    const envioEntregaEstimado = s(req.body?.envioEntregaEstimado)
    const envioCostoFijo = nOrNull(req.body?.envioCostoFijo)
    const envioGratisDesde = nOrNull(req.body?.envioGratisDesde)

    // 🧾 Post-venta
    const facturaElectronicaInfo = s(req.body?.facturaElectronicaInfo)
    const soporteDevolucionesInfo = s(req.body?.soporteDevolucionesInfo)

    // Reglas mínimas para no guardar vacío del todo (igual que antes)
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    try {
        const data: any = {
            // base
            nombre,
            descripcion,
            servicios,
            faq,
            horarios,
            businessType,
            disclaimers,

            // operación
            enviosInfo,
            metodosPago,
            tiendaFisica,
            direccionTienda,
            politicasDevolucion,
            politicasGarantia,
            promocionesInfo,
            canalesAtencion,
            extras,
            palabrasClaveNegocio,

            // escalamiento
            escalarSiNoConfia,
            escalarPalabrasClave,
            escalarPorReintentos,

            // ecommerce pagos
            pagoLinkGenerico,
            pagoLinkProductoBase,
            pagoNotas, // TEXT nullable

            bancoNombre,
            bancoTitular,
            bancoTipoCuenta,
            bancoNumeroCuenta,
            bancoDocumento,
            transferenciaQRUrl,

            // envíos
            envioTipo,
            envioEntregaEstimado,
            envioCostoFijo,   // Decimal? -> Prisma acepta number | string
            envioGratisDesde, // Decimal?

            // post-venta
            facturaElectronicaInfo,
            soporteDevolucionesInfo,
        }

        // Quitar claves Decimal que vengan null para no sobrescribir con null si tu
        // formulario no envía el campo (opcional)
        if (data.envioCostoFijo === null) delete data.envioCostoFijo
        if (data.envioGratisDesde === null) delete data.envioGratisDesde

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

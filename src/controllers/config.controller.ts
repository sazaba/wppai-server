// server/src/controllers/config.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"
import {
    AiMode,
    AgentSpecialty,
    BusinessType,
    Prisma,
} from "@prisma/client"

// Helpers básicos
const s = (v: any, def = "") => (v === undefined || v === null ? def : String(v).trim())
const b = (v: any, def = false) => (v === undefined || v === null ? def : Boolean(v))
const nOrNull = (v: any) => {
    if (v === undefined || v === null || v === "") return null
    const num = Number(v)
    return Number.isFinite(num) ? num : null
}
const oneOf = <T extends string>(raw: any, allowed: readonly T[], def: T): T => {
    const v = String(raw ?? "").toLowerCase() as T
    return (allowed as readonly string[]).includes(v) ? (v as T) : def
}

// ---- Mapeadores string -> enum Prisma
const toBusinessType = (v: "servicios" | "productos"): BusinessType =>
    v === "productos" ? BusinessType.productos : BusinessType.servicios

const toAiMode = (v: "ecommerce" | "agente"): AiMode =>
    v === "agente" ? AiMode.agente : AiMode.ecommerce

const toAgentSpecialty = (
    v: "generico" | "medico" | "dermatologia" | "nutricion" | "psicologia" | "odontologia"
): AgentSpecialty => {
    switch (v) {
        case "medico": return AgentSpecialty.medico
        case "dermatologia": return AgentSpecialty.dermatologia
        case "nutricion": return AgentSpecialty.nutricion
        case "psicologia": return AgentSpecialty.psicologia
        case "odontologia": return AgentSpecialty.odontologia
        default: return AgentSpecialty.generico
    }
}

// === GET /api/config
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

// === PUT /api/config
export async function upsertConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    // Base
    const nombre = s(req.body?.nombre)
    const descripcion = s(req.body?.descripcion)
    const servicios = s(req.body?.servicios)
    const faq = s(req.body?.faq)
    const horarios = s(req.body?.horarios)

    // ⬅️ CORREGIDO: string union + enum Prisma
    const businessTypeStr = oneOf(req.body?.businessType, ["servicios", "productos"] as const, "servicios")
    const businessType = toBusinessType(businessTypeStr)

    const disclaimers = s(req.body?.disclaimers)

    // IA / Agente
    const aiModeStr = oneOf(req.body?.aiMode, ["ecommerce", "agente"] as const, "ecommerce")
    const aiMode = toAiMode(aiModeStr)

    const agentSpecialtyStr = oneOf(
        req.body?.agentSpecialty,
        ["generico", "medico", "dermatologia", "nutricion", "psicologia", "odontologia"] as const,
        "generico"
    )
    const agentSpecialty = toAgentSpecialty(agentSpecialtyStr)

    const agentPrompt = aiMode === AiMode.agente ? (s(req.body?.agentPrompt) || null) : null
    const agentScope = aiMode === AiMode.agente ? (s(req.body?.agentScope) || null) : null
    const agentDisclaimers = aiMode === AiMode.agente ? (s(req.body?.agentDisclaimers) || null) : null

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

    // Escalamiento
    const escalarSiNoConfia = b(req.body?.escalarSiNoConfia, true)
    const escalarPalabrasClave = s(req.body?.escalarPalabrasClave)
    const escalarPorReintentos = Number(req.body?.escalarPorReintentos ?? 0) || 0

    // Pagos
    const pagoLinkGenerico = s(req.body?.pagoLinkGenerico)
    const pagoLinkProductoBase = s(req.body?.pagoLinkProductoBase)
    const pagoNotasRaw = req.body?.pagoNotas
    const pagoNotas = pagoNotasRaw === null ? null : s(pagoNotasRaw) || null

    const bancoNombre = s(req.body?.bancoNombre)
    const bancoTitular = s(req.body?.bancoTitular)
    const bancoTipoCuenta = s(req.body?.bancoTipoCuenta)
    const bancoNumeroCuenta = s(req.body?.bancoNumeroCuenta)
    const bancoDocumento = s(req.body?.bancoDocumento)
    const transferenciaQRUrl = s(req.body?.transferenciaQRUrl)

    // Envío
    const envioTipo = s(req.body?.envioTipo)
    const envioEntregaEstimado = s(req.body?.envioEntregaEstimado)
    const envioCostoFijo = nOrNull(req.body?.envioCostoFijo)
    const envioGratisDesde = nOrNull(req.body?.envioGratisDesde)

    // Post-venta
    const facturaElectronicaInfo = s(req.body?.facturaElectronicaInfo)
    const soporteDevolucionesInfo = s(req.body?.soporteDevolucionesInfo)

    // Validación mínima
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    try {
        // Tipado explícito para Prisma (evita 'as any')
        const data: Prisma.BusinessConfigUncheckedCreateInput = {
            empresaId, // este campo se ignora en update
            // base
            nombre,
            descripcion,
            servicios,
            faq,
            horarios,
            businessType,
            disclaimers,

            // IA
            aiMode,
            agentSpecialty,
            agentPrompt,
            agentScope,
            agentDisclaimers,

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

            // pagos
            pagoLinkGenerico,
            pagoLinkProductoBase,
            pagoNotas,

            bancoNombre,
            bancoTitular,
            bancoTipoCuenta,
            bancoNumeroCuenta,
            bancoDocumento,
            transferenciaQRUrl,

            // envíos
            envioTipo,
            envioEntregaEstimado,
            envioCostoFijo: envioCostoFijo as any,   // Prisma acepta number; mantenemos compat
            envioGratisDesde: envioGratisDesde as any,

            // post-venta
            facturaElectronicaInfo,
            soporteDevolucionesInfo,
        }

        // No sobreescribir a null los decimales si no vinieron
        const toUpdate: Prisma.BusinessConfigUncheckedUpdateInput = { ...data }
        delete (toUpdate as any).empresaId
        if (envioCostoFijo === null) delete (toUpdate as any).envioCostoFijo
        if (envioGratisDesde === null) delete (toUpdate as any).envioGratisDesde

        const existente = await prisma.businessConfig.findUnique({ where: { empresaId } })

        const cfg = existente
            ? await prisma.businessConfig.update({ where: { empresaId }, data: toUpdate })
            : await prisma.businessConfig.create({ data })

        return res.json(cfg)
    } catch (error) {
        console.error("[upsertConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración" })
    }
}

/**
 * === PUT /api/config/agent
 * Guarda SOLO el modo/parametría del agente.
 */
export async function upsertAgentConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    const aiModeStr = oneOf(req.body?.aiMode, ["ecommerce", "agente"] as const, "agente")
    const agentSpecialtyStr = oneOf(
        req.body?.agentSpecialty,
        ["generico", "medico", "dermatologia", "nutricion", "psicologia", "odontologia"] as const,
        "generico"
    )

    const aiMode = toAiMode(aiModeStr)
    const agentSpecialty = toAgentSpecialty(agentSpecialtyStr)

    const agentPrompt = s(req.body?.agentPrompt) || null
    const agentScope = s(req.body?.agentScope) || null
    const agentDisclaimers = s(req.body?.agentDisclaimers) || null

    try {
        const existente = await prisma.businessConfig.findUnique({ where: { empresaId } })

        const data: Prisma.BusinessConfigUncheckedUpdateInput = {
            aiMode,
            agentSpecialty,
            agentPrompt,
            agentScope,
            agentDisclaimers,
        }

        const cfg = existente
            ? await prisma.businessConfig.update({ where: { empresaId }, data })
            : await prisma.businessConfig.create({ data: { empresaId, ...data } as Prisma.BusinessConfigUncheckedCreateInput })

        return res.json(cfg)
    } catch (error) {
        console.error("[upsertAgentConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración del agente" })
    }
}

// === GET /api/config/all
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

// === DELETE /api/config/:id
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

// === POST /api/config/reset?withCatalog=1
export async function resetConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const withCatalog = ["1", "true", "yes"].includes(String(req.query.withCatalog || "").toLowerCase())

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

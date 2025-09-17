// server/src/controllers/config.controller.ts
import { Request, Response } from "express"
import prisma from "../lib/prisma"
// 👉 Tipos (solo TS) y Prisma para *UncheckedCreate/UpdateInput*
import type { AiMode, AgentSpecialty, BusinessType, AppointmentVertical } from "@prisma/client"
import { Prisma } from "@prisma/client"

/* ---------------------- Helpers básicos ---------------------- */
const s = (v: any, def = "") => (v === undefined || v === null ? def : String(v).trim())

// boolean robusto: soporta "1/0", "true/false", "yes/no", "si/sí"
const b = (v: any, def = false) => {
    if (v === undefined || v === null || v === "") return def
    if (typeof v === "boolean") return v
    const st = String(v).trim().toLowerCase()
    if (["1", "true", "yes", "si", "sí"].includes(st)) return true
    if (["0", "false", "no"].includes(st)) return false
    return Boolean(v)
}

const nOrNull = (v: any) => {
    if (v === undefined || v === null || v === "") return null
    const num = Number(v)
    return Number.isFinite(num) ? num : null
}

const oneOf = <T extends string>(raw: any, allowed: readonly T[], def: T): T => {
    const v = String(raw ?? "").toLowerCase() as T
    return (allowed as readonly string[]).includes(v) ? (v as T) : def
}

/* ---------------------- Mapeadores a enums ---------------------- */
const toBusinessType = (v: "servicios" | "productos"): BusinessType =>
    (v === "productos" ? "productos" : "servicios") as BusinessType

// ✅ contempla 'appointments'
const toAiMode = (v: "ecommerce" | "agente" | "appointments"): AiMode =>
    (v === "agente" ? "agente" : v === "appointments" ? "appointments" : "ecommerce") as AiMode

const toAgentSpecialty = (
    v: "generico" | "medico" | "dermatologia" | "nutricion" | "psicologia" | "odontologia"
): AgentSpecialty =>
    (["medico", "dermatologia", "nutricion", "psicologia", "odontologia"].includes(v)
        ? v
        : "generico") as AgentSpecialty

const toAppointmentVertical = (v: any): AppointmentVertical => {
    const allowed: AppointmentVertical[] = ["none", "salud", "bienestar", "automotriz", "veterinaria", "fitness", "otros"]
    const st = String(v ?? "").toLowerCase() as AppointmentVertical
    return (allowed as readonly string[]).includes(st) ? (st as AppointmentVertical) : "none"
}

/* ---------------------- GET /api/config ---------------------- */
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

/* ---------------------- PUT /api/config ---------------------- */
export async function upsertConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    // Base
    const nombre = s(req.body?.nombre)
    const descripcion = s(req.body?.descripcion)
    // 👇 tomar del form de citas si viene; si no, usa servicios “general”
    const servicios = s(req.body?.appointmentServices ?? req.body?.servicios)
    const faq = s(req.body?.faq)
    const horarios = s(req.body?.horarios)

    const businessTypeStr = oneOf(req.body?.businessType, ["servicios", "productos"] as const, "servicios")
    const businessType = toBusinessType(businessTypeStr)

    const disclaimers = s(req.body?.disclaimers)

    // IA / Agente — acepta 'appointments'
    const aiModeStr = oneOf(req.body?.aiMode, ["ecommerce", "agente", "appointments"] as const, "ecommerce")
    // considerar que vino en body solo si no es undefined/null/""
    const aiModeFromBody: AiMode | undefined =
        req.body?.aiMode !== undefined && req.body?.aiMode !== null && req.body?.aiMode !== ""
            ? toAiMode(aiModeStr)
            : undefined

    const agentSpecialtyStr = oneOf(
        req.body?.agentSpecialty,
        ["generico", "medico", "dermatologia", "nutricion", "psicologia", "odontologia"] as const,
        "generico"
    )
    const agentSpecialty = toAgentSpecialty(agentSpecialtyStr)

    // Solo relevantes si el body pidió explícitamente 'agente'
    const agentPrompt = aiModeFromBody === "agente" ? (s(req.body?.agentPrompt) || null) : null
    const agentScope = aiModeFromBody === "agente" ? (s(req.body?.agentScope) || null) : null
    const agentDisclaimers = aiModeFromBody === "agente" ? (s(req.body?.agentDisclaimers) || null) : null

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

    // ====== Agenda / Citas
    const appointmentEnabled = b(req.body?.appointmentEnabled, false)
    const appointmentVertical = toAppointmentVertical(req.body?.appointmentVertical)
    const appointmentTimezone = s(req.body?.appointmentTimezone || "America/Bogota") || "America/Bogota"
    const appointmentBufferMin = Number(req.body?.appointmentBufferMin ?? 10) || 10
    const appointmentPolicies =
        req.body?.appointmentPolicies === null ? null : s(req.body?.appointmentPolicies) || null
    const appointmentReminders = b(req.body?.appointmentReminders, true)

    // Validación mínima
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." })
    }

    // ✅ Prioridad para aiMode:
    // 1) si el body pide 'agente' -> agente
    // 2) si appointmentEnabled=true -> appointments
    // 3) en otro caso, usar lo que vino en el body (o no tocar en update)
    const finalAiMode: AiMode | undefined =
        aiModeFromBody === "agente"
            ? "agente"
            : appointmentEnabled
                ? ("appointments" as AiMode)
                : aiModeFromBody

    try {
        const data: Prisma.BusinessConfigUncheckedCreateInput = {
            empresaId,
            // base
            nombre,
            descripcion,
            servicios,
            faq,
            horarios,
            businessType,
            disclaimers,

            // IA (para CREATE necesitamos un valor)
            aiMode: finalAiMode ?? "ecommerce",
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
            envioCostoFijo: envioCostoFijo as any,
            envioGratisDesde: envioGratisDesde as any,

            // post-venta
            facturaElectronicaInfo,
            soporteDevolucionesInfo,

            // ===== agenda/citas
            appointmentEnabled,
            appointmentVertical,
            appointmentTimezone,
            appointmentBufferMin,
            appointmentPolicies,
            appointmentReminders,
        }

        const toUpdate: Prisma.BusinessConfigUncheckedUpdateInput = { ...data }
        delete (toUpdate as any).empresaId
        if (envioCostoFijo === null) delete (toUpdate as any).envioCostoFijo
        if (envioGratisDesde === null) delete (toUpdate as any).envioGratisDesde

        // no sobrescribir campos de citas si no vinieron en body
        if (req.body?.appointmentEnabled === undefined) delete (toUpdate as any).appointmentEnabled
        if (req.body?.appointmentVertical === undefined) delete (toUpdate as any).appointmentVertical
        if (req.body?.appointmentTimezone === undefined) delete (toUpdate as any).appointmentTimezone
        if (req.body?.appointmentBufferMin === undefined) delete (toUpdate as any).appointmentBufferMin
        if (req.body?.appointmentPolicies === undefined) delete (toUpdate as any).appointmentPolicies
        if (req.body?.appointmentReminders === undefined) delete (toUpdate as any).appointmentReminders

        // ⛔ clave: si NO debemos tocar aiMode en update, quitarlo del payload
        if (!finalAiMode) delete (toUpdate as any).aiMode

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

/* ---------------------- PUT /api/config/agent ---------------------- */
/** Guarda SOLO el modo/perfil del agente (no toca agenda). */
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
        // Si no existe, crear registro mínimo para no romper validaciones.
        const createMinimos: Prisma.BusinessConfigUncheckedCreateInput = {
            empresaId,
            // base mínimas
            nombre: "",
            descripcion: s(req.body?.descripcion) || "",
            servicios: s(req.body?.servicios) || "",
            faq: s(req.body?.faq) || "",
            horarios: s(req.body?.horarios) || "",
            businessType: "servicios",
            disclaimers: s(req.body?.disclaimers) || "",

            // IA
            aiMode,
            agentSpecialty,
            agentPrompt,
            agentScope,
            agentDisclaimers,

            // operación mínimas
            enviosInfo: s(req.body?.enviosInfo) || "",
            metodosPago: s(req.body?.metodosPago) || "",
            tiendaFisica: false,
            direccionTienda: "",
            politicasDevolucion: s(req.body?.politicasDevolucion) || "",
            politicasGarantia: s(req.body?.politicasGarantia) || "",
            promocionesInfo: s(req.body?.promocionesInfo) || "",
            canalesAtencion: s(req.body?.canalesAtencion) || "",
            extras: s(req.body?.extras) || "",
            palabrasClaveNegocio: "",

            // pagos/envíos (defaults)
            pagoLinkGenerico: "",
            pagoLinkProductoBase: "",
            pagoNotas: null,
            bancoNombre: "",
            bancoTitular: "",
            bancoTipoCuenta: "",
            bancoNumeroCuenta: "",
            bancoDocumento: "",
            transferenciaQRUrl: "",
            envioTipo: "",
            envioEntregaEstimado: "",
            envioCostoFijo: undefined as any,
            envioGratisDesde: undefined as any,

            // post-venta
            facturaElectronicaInfo: "",
            soporteDevolucionesInfo: "",

            // escalamiento
            escalarSiNoConfia: true,
            escalarPalabrasClave: "",
            escalarPorReintentos: 0,

            // ⚠️ Agenda NO se toca desde este endpoint
        }

        const updateSoloAgente: Prisma.BusinessConfigUncheckedUpdateInput = {
            aiMode,
            agentSpecialty,
            agentPrompt,
            agentScope,
            agentDisclaimers,
            // 🔒 Exclusividad: si pasamos a agente, apagamos las citas
            ...(aiMode === "agente" && { appointmentEnabled: false }),
            // si vienen, actualiza algunos textos base también:
            ...(req.body?.descripcion !== undefined && { descripcion: s(req.body.descripcion) }),
            ...(req.body?.servicios !== undefined && { servicios: s(req.body.servicios) }),
            ...(req.body?.faq !== undefined && { faq: s(req.body.faq) }),
            ...(req.body?.horarios !== undefined && { horarios: s(req.body.horarios) }),
            ...(req.body?.disclaimers !== undefined && { disclaimers: s(req.body.disclaimers) }),
            ...(req.body?.enviosInfo !== undefined && { enviosInfo: s(req.body.enviosInfo) }),
            ...(req.body?.metodosPago !== undefined && { metodosPago: s(req.body.metodosPago) }),
            ...(req.body?.politicasDevolucion !== undefined && { politicasDevolucion: s(req.body.politicasDevolucion) }),
            ...(req.body?.politicasGarantia !== undefined && { politicasGarantia: s(req.body.politicasGarantia) }),
            ...(req.body?.promocionesInfo !== undefined && { promocionesInfo: s(req.body.promocionesInfo) }),
            ...(req.body?.canalesAtencion !== undefined && { canalesAtencion: s(req.body.canalesAtencion) }),
            ...(req.body?.extras !== undefined && { extras: s(req.body.extras) }),
        }

        const cfg = await prisma.businessConfig.upsert({
            where: { empresaId },
            update: updateSoloAgente,
            create: createMinimos,
        })

        return res.json(cfg)
    } catch (error) {
        console.error("[upsertAgentConfig] error:", error)
        return res.status(500).json({ error: "No se pudo guardar la configuración del agente" })
    }
}

/* ---------------------- GET /api/config/all ---------------------- */
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

/* ---------------------- DELETE /api/config/:id ---------------------- */
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

/* ---------------------- POST /api/config/reset ---------------------- */
export async function resetConfig(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number

    const withCatalog = ["1", "true", "yes"].includes(String(req.query.withCatalog || "").toLowerCase())
    const withAppointments =
        !["0", "false", "no"].includes(String(req.query.withAppointments || "").toLowerCase())

    try {
        await prisma.$transaction(async (tx) => {
            // 🧹 Horarios de citas (si lo permites; por defecto sí)
            if (withAppointments) {
                await tx.appointmentHour.deleteMany({ where: { empresaId } }).catch(() => { })
            }

            // 🧹 Config del negocio
            await tx.businessConfig.deleteMany({ where: { empresaId } }).catch(() => { })

            // 🧹 Catálogo (opcional)
            if (withCatalog) {
                await tx.productImage.deleteMany({ where: { product: { empresaId } } }).catch(() => { })
                await tx.product.deleteMany({ where: { empresaId } }).catch(() => { })
            }
        })

        return res.json({ ok: true, withCatalog, withAppointments })
    } catch (error) {
        console.error("[resetConfig] error:", error)
        return res.status(500).json({ error: "No se pudo reiniciar la configuración" })
    }
}

// Alias (compat)
export const resetConfigDelete = resetConfig

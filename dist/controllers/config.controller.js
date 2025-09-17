"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetConfigDelete = void 0;
exports.getConfig = getConfig;
exports.upsertConfig = upsertConfig;
exports.upsertAgentConfig = upsertAgentConfig;
exports.getAllConfigs = getAllConfigs;
exports.deleteConfig = deleteConfig;
exports.resetConfig = resetConfig;
const prisma_1 = __importDefault(require("../lib/prisma"));
/* ---------------------- Helpers básicos ---------------------- */
const s = (v, def = "") => (v === undefined || v === null ? def : String(v).trim());
const b = (v, def = false) => (v === undefined || v === null ? def : Boolean(v));
const nOrNull = (v) => {
    if (v === undefined || v === null || v === "")
        return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
};
const oneOf = (raw, allowed, def) => {
    const v = String(raw ?? "").toLowerCase();
    return allowed.includes(v) ? v : def;
};
// JSON seguro (acepta objeto o string JSON; si falla, devuelve def)
const parseJson = (raw, def = null) => {
    if (raw === undefined || raw === null || raw === "")
        return def;
    if (typeof raw === "object")
        return raw;
    try {
        return JSON.parse(String(raw));
    }
    catch {
        return def;
    }
};
/* ---------------------- Mapeadores a enums ---------------------- */
const toBusinessType = (v) => (v === "productos" ? "productos" : "servicios");
const toAiMode = (v) => (v === "agente" ? "agente" : "ecommerce");
const toAgentSpecialty = (v) => (["medico", "dermatologia", "nutricion", "psicologia", "odontologia"].includes(v)
    ? v
    : "generico");
const toAppointmentVertical = (v) => {
    const allowed = ["none", "salud", "bienestar", "automotriz", "veterinaria", "fitness", "otros"];
    const s = String(v ?? "").toLowerCase();
    return allowed.includes(s) ? s : "none";
};
/* ---------------------- GET /api/config ---------------------- */
async function getConfig(req, res) {
    const empresaId = req.user?.empresaId;
    try {
        const cfg = await prisma_1.default.businessConfig.findUnique({ where: { empresaId } });
        return res.json(cfg);
    }
    catch (error) {
        console.error("[getConfig] error:", error);
        return res.status(500).json({ error: "No se pudo obtener la configuración" });
    }
}
/* ---------------------- PUT /api/config ---------------------- */
async function upsertConfig(req, res) {
    const empresaId = req.user?.empresaId;
    // Base
    const nombre = s(req.body?.nombre);
    const descripcion = s(req.body?.descripcion);
    const servicios = s(req.body?.servicios);
    const faq = s(req.body?.faq);
    const horarios = s(req.body?.horarios);
    const businessTypeStr = oneOf(req.body?.businessType, ["servicios", "productos"], "servicios");
    const businessType = toBusinessType(businessTypeStr);
    const disclaimers = s(req.body?.disclaimers);
    // IA / Agente
    const aiModeStr = oneOf(req.body?.aiMode, ["ecommerce", "agente"], "ecommerce");
    const aiMode = toAiMode(aiModeStr);
    const agentSpecialtyStr = oneOf(req.body?.agentSpecialty, ["generico", "medico", "dermatologia", "nutricion", "psicologia", "odontologia"], "generico");
    const agentSpecialty = toAgentSpecialty(agentSpecialtyStr);
    const agentPrompt = aiMode === "agente" ? (s(req.body?.agentPrompt) || null) : null;
    const agentScope = aiMode === "agente" ? (s(req.body?.agentScope) || null) : null;
    const agentDisclaimers = aiMode === "agente" ? (s(req.body?.agentDisclaimers) || null) : null;
    // Operación
    const enviosInfo = s(req.body?.enviosInfo);
    const metodosPago = s(req.body?.metodosPago);
    const tiendaFisica = b(req.body?.tiendaFisica, false);
    const direccionTienda = s(req.body?.direccionTienda);
    const politicasDevolucion = s(req.body?.politicasDevolucion);
    const politicasGarantia = s(req.body?.politicasGarantia);
    const promocionesInfo = s(req.body?.promocionesInfo);
    const canalesAtencion = s(req.body?.canalesAtencion);
    const extras = s(req.body?.extras);
    const palabrasClaveNegocio = s(req.body?.palabrasClaveNegocio);
    // Escalamiento
    const escalarSiNoConfia = b(req.body?.escalarSiNoConfia, true);
    const escalarPalabrasClave = s(req.body?.escalarPalabrasClave);
    const escalarPorReintentos = Number(req.body?.escalarPorReintentos ?? 0) || 0;
    // Pagos
    const pagoLinkGenerico = s(req.body?.pagoLinkGenerico);
    const pagoLinkProductoBase = s(req.body?.pagoLinkProductoBase);
    const pagoNotasRaw = req.body?.pagoNotas;
    const pagoNotas = pagoNotasRaw === null ? null : s(pagoNotasRaw) || null;
    const bancoNombre = s(req.body?.bancoNombre);
    const bancoTitular = s(req.body?.bancoTitular);
    const bancoTipoCuenta = s(req.body?.bancoTipoCuenta);
    const bancoNumeroCuenta = s(req.body?.bancoNumeroCuenta);
    const bancoDocumento = s(req.body?.bancoDocumento);
    const transferenciaQRUrl = s(req.body?.transferenciaQRUrl);
    // Envío
    const envioTipo = s(req.body?.envioTipo);
    const envioEntregaEstimado = s(req.body?.envioEntregaEstimado);
    const envioCostoFijo = nOrNull(req.body?.envioCostoFijo);
    const envioGratisDesde = nOrNull(req.body?.envioGratisDesde);
    // Post-venta
    const facturaElectronicaInfo = s(req.body?.facturaElectronicaInfo);
    const soporteDevolucionesInfo = s(req.body?.soporteDevolucionesInfo);
    // ====== Agenda / Citas (opcionales)
    const appointmentEnabled = b(req.body?.appointmentEnabled, false);
    const appointmentVertical = toAppointmentVertical(req.body?.appointmentVertical);
    const appointmentTimezone = s(req.body?.appointmentTimezone || "America/Bogota") || "America/Bogota";
    const appointmentBufferMin = Number(req.body?.appointmentBufferMin ?? 10) || 10;
    const appointmentPolicies = (req.body?.appointmentPolicies === null) ? null : (s(req.body?.appointmentPolicies) || null);
    const appointmentReminders = b(req.body?.appointmentReminders, true);
    // 🚫 Eliminado appointmentWorkHours (ya no existe en el modelo)
    // Validación mínima
    if (!nombre || !descripcion || !faq || !horarios) {
        return res.status(400).json({ error: "Faltan campos requeridos." });
    }
    try {
        const data = {
            empresaId,
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
            envioCostoFijo: envioCostoFijo,
            envioGratisDesde: envioGratisDesde,
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
        };
        const toUpdate = { ...data };
        delete toUpdate.empresaId;
        if (envioCostoFijo === null)
            delete toUpdate.envioCostoFijo;
        if (envioGratisDesde === null)
            delete toUpdate.envioGratisDesde;
        // evita sobrescribir si no vienen en body (opcional)
        if (req.body?.appointmentEnabled === undefined)
            delete toUpdate.appointmentEnabled;
        if (req.body?.appointmentVertical === undefined)
            delete toUpdate.appointmentVertical;
        if (req.body?.appointmentTimezone === undefined)
            delete toUpdate.appointmentTimezone;
        if (req.body?.appointmentBufferMin === undefined)
            delete toUpdate.appointmentBufferMin;
        if (req.body?.appointmentPolicies === undefined)
            delete toUpdate.appointmentPolicies;
        if (req.body?.appointmentReminders === undefined)
            delete toUpdate.appointmentReminders;
        const existente = await prisma_1.default.businessConfig.findUnique({ where: { empresaId } });
        const cfg = existente
            ? await prisma_1.default.businessConfig.update({ where: { empresaId }, data: toUpdate })
            : await prisma_1.default.businessConfig.create({ data });
        return res.json(cfg);
    }
    catch (error) {
        console.error("[upsertConfig] error:", error);
        return res.status(500).json({ error: "No se pudo guardar la configuración" });
    }
}
/* ---------------------- PUT /api/config/agent ---------------------- */
/** Guarda SOLO el modo/perfil del agente (no toca agenda). */
async function upsertAgentConfig(req, res) {
    const empresaId = req.user?.empresaId;
    const aiModeStr = oneOf(req.body?.aiMode, ["ecommerce", "agente"], "agente");
    const agentSpecialtyStr = oneOf(req.body?.agentSpecialty, ["generico", "medico", "dermatologia", "nutricion", "psicologia", "odontologia"], "generico");
    const aiMode = toAiMode(aiModeStr);
    const agentSpecialty = toAgentSpecialty(agentSpecialtyStr);
    const agentPrompt = s(req.body?.agentPrompt) || null;
    const agentScope = s(req.body?.agentScope) || null;
    const agentDisclaimers = s(req.body?.agentDisclaimers) || null;
    try {
        // Si no existe el registro, creamos uno "mínimo" con strings vacíos para no romper validaciones.
        const createMinimos = {
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
            envioCostoFijo: undefined,
            envioGratisDesde: undefined,
            // post-venta
            facturaElectronicaInfo: "",
            soporteDevolucionesInfo: "",
            // escalamiento
            escalarSiNoConfia: true,
            escalarPalabrasClave: "",
            escalarPorReintentos: 0,
            // ⚠️ Agenda NO se toca desde este endpoint
        };
        const updateSoloAgente = {
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
        };
        const cfg = await prisma_1.default.businessConfig.upsert({
            where: { empresaId },
            update: updateSoloAgente,
            create: createMinimos,
        });
        return res.json(cfg);
    }
    catch (error) {
        console.error("[upsertAgentConfig] error:", error);
        return res.status(500).json({ error: "No se pudo guardar la configuración del agente" });
    }
}
/* ---------------------- GET /api/config/all ---------------------- */
async function getAllConfigs(req, res) {
    const empresaId = req.user?.empresaId;
    try {
        const list = await prisma_1.default.businessConfig.findMany({
            where: { empresaId },
            orderBy: { createdAt: "desc" },
        });
        return res.json(list);
    }
    catch (error) {
        console.error("[getAllConfigs] error:", error);
        return res.status(500).json({ error: "Error al obtener configuraciones" });
    }
}
/* ---------------------- DELETE /api/config/:id ---------------------- */
async function deleteConfig(req, res) {
    const empresaId = req.user?.empresaId;
    const id = Number(req.params.id);
    try {
        const existente = await prisma_1.default.businessConfig.findUnique({ where: { id } });
        if (!existente || existente.empresaId !== empresaId) {
            return res.status(404).json({ error: "No autorizado para eliminar esta configuración" });
        }
        await prisma_1.default.businessConfig.delete({ where: { id } });
        return res.json({ message: "Configuración eliminada" });
    }
    catch (error) {
        console.error("[deleteConfig] error:", error);
        return res.status(500).json({ error: "No se pudo eliminar la configuración" });
    }
}
/* ---------------------- POST /api/config/reset ---------------------- */
/* ---------------------- POST /api/config/reset ---------------------- */
async function resetConfig(req, res) {
    const empresaId = req.user?.empresaId;
    // ya existente en tu código
    const withCatalog = ["1", "true", "yes"].includes(String(req.query.withCatalog || "").toLowerCase());
    // opcional; por defecto borra horarios
    const withAppointments = !["0", "false", "no"].includes(String(req.query.withAppointments || "").toLowerCase());
    try {
        await prisma_1.default.$transaction(async (tx) => {
            // 🧹 Horarios de citas (si lo permites; por defecto sí)
            if (withAppointments) {
                await tx.appointmentHour.deleteMany({ where: { empresaId } }).catch(() => { });
            }
            // 🧹 Config del negocio — usar deleteMany por si existe “basura” duplicada
            await tx.businessConfig.deleteMany({ where: { empresaId } }).catch(() => { });
            // 🧹 Catálogo (opcional)
            if (withCatalog) {
                await tx.productImage.deleteMany({ where: { product: { empresaId } } }).catch(() => { });
                await tx.product.deleteMany({ where: { empresaId } }).catch(() => { });
            }
        });
        // contrato compatible (solo agrego withAppointments como info extra)
        return res.json({ ok: true, withCatalog, withAppointments });
    }
    catch (error) {
        console.error("[resetConfig] error:", error);
        return res.status(500).json({ error: "No se pudo reiniciar la configuración" });
    }
}
// Alias (compat)
exports.resetConfigDelete = resetConfig;

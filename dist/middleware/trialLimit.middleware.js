"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTrialLimits = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const checkTrialLimits = async (req, res, next) => {
    const empresaId = req.user?.empresaId;
    if (!empresaId) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    try {
        const empresa = await prisma_1.default.empresa.findUnique({
            where: { id: empresaId }
        });
        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }
        // Si es plan pro → no validar
        if (empresa.plan === 'pro') {
            return next();
        }
        const ahora = new Date();
        // Verificar expiración de prueba
        if (empresa.trialEnd && ahora > empresa.trialEnd) {
            return res.status(403).json({ error: 'La prueba gratuita ha finalizado' });
        }
        // Verificar límite de mensajes
        if (empresa.conversationsUsed >= 100) {
            return res.status(403).json({ error: 'Límite de 100 mensajes alcanzado en la prueba gratuita' });
        }
        // Incrementar contador de mensajes enviados
        await prisma_1.default.empresa.update({
            where: { id: empresaId },
            data: {
                conversationsUsed: { increment: 1 }
            }
        });
        next();
    }
    catch (error) {
        console.error('[checkTrialLimits] Error:', error);
        return res.status(500).json({ error: 'Error verificando límites de prueba' });
    }
};
exports.checkTrialLimits = checkTrialLimits;

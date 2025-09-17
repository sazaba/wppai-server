"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleIAReply = void 0;
// server/src/utils/handleIAReply.ts
const prisma_1 = __importDefault(require("../lib/prisma"));
const handleIAReply_ecommerce_1 = require("./handleIAReply.ecommerce");
const agent_strategy_1 = require("./ai/strategies/agent.strategy");
const client_1 = require("@prisma/client");
/**
 * Orquestador: decide la estrategia según BusinessConfig.aiMode
 * - aiMode = ecommerce  -> delega a lógica existente (intacta)
 * - aiMode = agente     -> usa el agente personalizado (con specialty)
 */
const handleIAReply = async (chatId, mensajeArg, opts) => {
    // 1) Leer conversación
    const conversacion = await prisma_1.default.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, empresaId: true, phone: true }
    });
    if (!conversacion)
        return null;
    if (conversacion.estado === client_1.ConversationEstado.cerrado) {
        console.warn(`[handleIAReply] 🔒 La conversación ${chatId} está cerrada.`);
        return null;
    }
    // 2) Leer config mínima para decidir estrategia
    const config = await prisma_1.default.businessConfig.findFirst({
        where: { empresaId: conversacion.empresaId },
        orderBy: { updatedAt: 'desc' },
        select: {
            id: true,
            aiMode: true,
            agentSpecialty: true,
            agentPrompt: true,
            agentScope: true,
            agentDisclaimers: true
        }
    });
    const mode = config?.aiMode ?? client_1.AiMode.ecommerce;
    if (mode === client_1.AiMode.agente) {
        return (0, agent_strategy_1.handleAgentReply)({
            chatId,
            empresaId: conversacion.empresaId,
            mensajeArg,
            toPhone: opts?.toPhone ?? conversacion.phone,
            phoneNumberId: opts?.phoneNumberId,
            agent: {
                specialty: (config?.agentSpecialty ?? client_1.AgentSpecialty.generico),
                prompt: config?.agentPrompt ?? '',
                scope: config?.agentScope ?? '',
                disclaimers: config?.agentDisclaimers ?? ''
            }
        });
    }
    // 3) Default/back-compat → e-commerce intacto
    return (0, handleIAReply_ecommerce_1.handleEcommerceIAReply)(chatId, mensajeArg, opts);
};
exports.handleIAReply = handleIAReply;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MESSAGE_SENDERS = exports.CONVERSATION_STATES = void 0;
// Estados posibles de la conversación
exports.CONVERSATION_STATES = {
    PENDIENTE: 'pendiente',
    RESPONDIDO: 'respondido',
    EN_PROCESO: 'en_proceso',
    REQUIERE_AGENTE: 'requiere_agente'
};
// Remitentes posibles de los mensajes
exports.MESSAGE_SENDERS = {
    CLIENT: 'client',
    BOT: 'bot'
};

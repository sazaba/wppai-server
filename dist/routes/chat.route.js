"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/chat.route.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const trialLimit_middleware_1 = require("../middleware/trialLimit.middleware");
// Importa TODO como objeto y desestructura (evita undefined por default/named)
const ChatCtrl = __importStar(require("../controllers/chat.controller"));
const { getConversations, getMessagesByConversation, postMessageToConversation, responderConIA, updateConversationEstado, cerrarConversacion, responderManual, crearConversacion, // <- debe existir/exportarse en el controller
iniciarChat, // <- opcional, si lo usas
 } = ChatCtrl;
const router = (0, express_1.Router)();
// JWT para todo
router.use(auth_middleware_1.verificarJWT);
// 📌 NO cuentan para el límite
router.get('/chats', getConversations);
router.get('/chats/:id/messages', getMessagesByConversation);
// 📌 Cuentan envío
router.post('/chats/:id/messages', trialLimit_middleware_1.checkTrialLimits, postMessageToConversation);
router.post('/responder', trialLimit_middleware_1.checkTrialLimits, responderConIA);
router.post('/chats/:id/responder-manual', trialLimit_middleware_1.checkTrialLimits, responderManual);
// 📌 Crear conversación (no cuenta)
router.post('/chats', crearConversacion);
// 📌 Iniciar fuera de 24h con plantilla (si lo usas)
if (iniciarChat) {
    router.post('/chats/iniciar', iniciarChat);
}
// 📌 Estados
router.put('/chats/:id/estado', updateConversationEstado);
router.put('/chats/:id/cerrar', cerrarConversacion);
exports.default = router;

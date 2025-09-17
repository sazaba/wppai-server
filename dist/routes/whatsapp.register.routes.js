"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/whatsapp.register.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const whatsapp_register_controller_1 = require("../controllers/whatsapp.register.controller");
const router = (0, express_1.Router)();
router.post('/whatsapp/activar-numero', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.activarNumero);
router.get('/whatsapp/numero/:phoneNumberId/estado', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.estadoNumero);
router.get('/whatsapp/waba/:wabaId/phones', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.listarTelefonosDeWaba);
router.post('/whatsapp/numero/:phoneNumberId/two-step', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.setTwoStepPin);
// (Opcional) flujo request/verify code clásico
router.post('/whatsapp/numero/:phoneNumberId/request-code', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.requestVerificationCode);
router.post('/whatsapp/numero/:phoneNumberId/verify-code', auth_middleware_1.verificarJWT, whatsapp_register_controller_1.verifyCode);
exports.default = router;

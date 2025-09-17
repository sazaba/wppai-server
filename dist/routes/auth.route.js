"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/auth.route.ts
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const router = (0, express_1.Router)();
// Públicas
router.post('/register', auth_controller_1.registrar);
router.post('/login', auth_controller_1.login);
// OAuth públicas
router.get('/whatsapp', auth_controller_1.iniciarOAuthMeta); // → /api/auth/whatsapp
router.get('/callback', auth_controller_1.authCallback); // → /api/auth/callback
router.post('/exchange-code', auth_controller_1.exchangeCode); // → /api/auth/exchange-code
// (Puedes dejar /wabas público mientras pruebas)
router.get('/wabas', auth_controller_1.getWabasAndPhones); // → /api/auth/wabas
exports.default = router;

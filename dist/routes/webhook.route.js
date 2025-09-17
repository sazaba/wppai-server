"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/webhook.route.ts
const express_1 = require("express");
const webhook_controller_1 = require("../controllers/webhook.controller");
const router = (0, express_1.Router)();
// GET para verificación de Meta (hub.challenge)
router.get('/', webhook_controller_1.verifyWebhook);
// POST para recibir eventos (messages, statuses)
router.post('/', webhook_controller_1.receiveWhatsappMessage);
exports.default = router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/payments.routes.ts
const express_1 = require("express");
const payments_controller_1 = require("../controllers/payments.controller");
// import { requireAuth } from "../middleware/auth"
const router = (0, express_1.Router)();
// router.use(requireAuth)
router.get("/", payments_controller_1.listPayments);
router.get("/:id", payments_controller_1.getPayment);
router.post("/receipt", payments_controller_1.createPaymentReceipt);
router.post("/:id/verify", payments_controller_1.verifyPayment);
exports.default = router;

// src/routes/billing.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    createPaymentMethod,
    deletePaymentMethod,
    createSubscriptionBasic,
    chargeSubscription,
    getBillingStatus,
    handleWompiWebhook,
    createSubscriptionPro,   // 👈 NUEVO: webhook dentro del mismo controller
} from "../controllers/billing.controller";

const router = Router();



/* ======================================================
   🔐 Rutas privadas — requieren JWT
   (se monta después del webhook)
====================================================== */
router.use(verificarJWT);

/* Dashboard de Billing */
router.get("/status", getBillingStatus);

/* Métodos de pago */
router.post("/payment-method", createPaymentMethod);
router.delete("/payment-method", deletePaymentMethod);

/* Suscripciones */
router.post("/subscription/basic", createSubscriptionBasic);
router.post("/subscription/pro", createSubscriptionPro);

router.post("/subscription/charge", chargeSubscription);

export default router;

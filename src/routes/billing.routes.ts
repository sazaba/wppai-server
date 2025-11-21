// src/routes/billing.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    createPaymentMethod,
    deletePaymentMethod,
    createSubscriptionBasic,
    chargeSubscription,
    getBillingStatus,
} from "../controllers/billing.controller";

const router = Router();

// Todas las rutas requieren JWT
router.use(verificarJWT);

// Dashboard
router.get("/status", getBillingStatus);

// Métodos de pago
router.post("/payment-method", createPaymentMethod);
router.delete("/payment-method", deletePaymentMethod);

// Suscripciones
router.post("/subscription/basic", createSubscriptionBasic);
router.post("/subscription/charge", chargeSubscription);

export default router;

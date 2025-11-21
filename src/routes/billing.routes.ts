// src/routes/billing.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    createPaymentMethod,
    createSubscriptionBasic,
    chargeSubscription,
} from "../controllers/billing.controller";

const router = Router();

// Todas las rutas requieren JWT
router.use(verificarJWT);

router.post("/payment-method", createPaymentMethod);
router.post("/subscription/basic", createSubscriptionBasic);
router.post("/subscription/charge", chargeSubscription);

export default router;

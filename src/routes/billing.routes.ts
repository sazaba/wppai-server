// src/routes/billing.routes.ts
import { Router } from "express";
import { verificarJWT } from "../middleware/auth.middleware";
import {
    createPaymentMethod,
    deletePaymentMethod,
    createSubscriptionBasic,
    createSubscriptionPro,
    chargeSubscription,
    getBillingStatus,
    handleWompiWebhook,
    purchaseConversationCredits,
} from "../controllers/billing.controller";

const router = Router();

/* ======================================================
   🌍 Rutas PÚBLICAS (Sin JWT)
   IMPORTANTE: El webhook de Wompi debe ir aquí, antes
   del middleware de autenticación, porque Wompi no
   envía tu token de usuario.
====================================================== */
router.post("/webhook", handleWompiWebhook);


/* ======================================================
   🔐 Rutas PRIVADAS — requieren JWT
   Todo lo que esté debajo de esta línea requiere login
====================================================== */
router.use(verificarJWT);

/* Dashboard de Billing */
router.get("/status", getBillingStatus);

/* Métodos de pago */
router.post("/payment-method", createPaymentMethod);
router.delete("/payment-method", deletePaymentMethod);

/* Suscripciones (Activar Plan) */
router.post("/subscription/basic", createSubscriptionBasic);
router.post("/subscription/pro", createSubscriptionPro);

/* Cobro manual de suscripción (Reintentos) */
router.post("/subscription/charge", chargeSubscription);

router.post("/purchase-credits", purchaseConversationCredits);

export default router;
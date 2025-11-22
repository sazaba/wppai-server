// server/src/routes/wompi.route.ts
import { Router } from "express";
import { handleWompiWebhook } from "../controllers/billing.controller";

const router = Router();

router.post("/webhook", handleWompiWebhook);

export default router;

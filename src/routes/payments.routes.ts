// server/src/routes/payments.routes.ts
import { Router } from "express"
import {
    listPayments,
    getPayment,
    createPaymentReceipt,
    verifyPayment,
} from "../controllers/payments.controller"

// import { requireAuth } from "../middleware/auth"

const router = Router()
// router.use(requireAuth)

router.get("/", listPayments)
router.get("/:id", getPayment)
router.post("/receipt", createPaymentReceipt)
router.post("/:id/verify", verifyPayment)

export default router

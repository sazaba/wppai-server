// server/src/routes/orders.routes.ts
import { Router } from "express"
import {
    createOrResumeFromConversation,
    listOrders,
    getOrder,
    updateOrder,
    deleteOrder,
    addItem,
    updateItem,
    deleteItem,
    forceRecalc,
    ensureVentaEnProceso,
} from "../controllers/orders.controller"

// Asegúrate de tener tu middleware de auth que inyecta user.empresaId
// import { requireAuth } from "../middleware/auth"

const router = Router()

// router.use(requireAuth)

router.post("/from-conversation/:conversationId", createOrResumeFromConversation)

router.get("/", listOrders)
router.get("/:id", getOrder)
router.put("/:id", updateOrder)
router.delete("/:id", deleteOrder)

router.post("/:id/items", addItem)
router.put("/:id/items/:itemId", updateItem)
router.delete("/:id/items/:itemId", deleteItem)

router.post("/:id/recalc", forceRecalc)
router.post("/:id/advance", ensureVentaEnProceso)

export default router

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/orders.routes.ts
const express_1 = require("express");
const orders_controller_1 = require("../controllers/orders.controller");
// Asegúrate de tener tu middleware de auth que inyecta user.empresaId
// import { requireAuth } from "../middleware/auth"
const router = (0, express_1.Router)();
// router.use(requireAuth)
router.post("/from-conversation/:conversationId", orders_controller_1.createOrResumeFromConversation);
router.get("/", orders_controller_1.listOrders);
router.get("/:id", orders_controller_1.getOrder);
router.put("/:id", orders_controller_1.updateOrder);
router.delete("/:id", orders_controller_1.deleteOrder);
router.post("/:id/items", orders_controller_1.addItem);
router.put("/:id/items/:itemId", orders_controller_1.updateItem);
router.delete("/:id/items/:itemId", orders_controller_1.deleteItem);
router.post("/:id/recalc", orders_controller_1.forceRecalc);
router.post("/:id/advance", orders_controller_1.ensureVentaEnProceso);
exports.default = router;

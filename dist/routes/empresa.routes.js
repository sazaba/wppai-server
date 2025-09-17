"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const empresa_controller_1 = require("../controllers/empresa.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
// 🛡️ Protegido por JWT
router.get('/empresa', auth_middleware_1.verificarJWT, empresa_controller_1.getEmpresa);
// 🔹 Actualizar plan (gratis ↔ pro)
router.put('/empresa/plan', auth_middleware_1.verificarJWT, empresa_controller_1.cambiarPlan);
exports.default = router;

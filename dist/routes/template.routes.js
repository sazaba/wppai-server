"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/template.routes.ts
const express_1 = require("express");
const template_controller_1 = require("../controllers/template.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.verificarJWT);
router.post('/', template_controller_1.crearPlantilla);
router.get('/', template_controller_1.listarPlantillas);
router.get('/:id', template_controller_1.obtenerPlantilla);
router.post('/:id/enviar', template_controller_1.enviarPlantillaAMeta);
router.get('/:id/estado', template_controller_1.consultarEstadoPlantilla);
router.delete('/:id', template_controller_1.eliminarPlantilla);
exports.default = router;

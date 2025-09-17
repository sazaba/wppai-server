"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/config.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const config_controller_1 = require("../controllers/config.controller");
const r = (0, express_1.Router)();
r.use(auth_middleware_1.verificarJWT);
r.get("/", config_controller_1.getConfig);
r.put("/", config_controller_1.upsertConfig);
r.put("/agent", config_controller_1.upsertAgentConfig); // ⬅️ NUEVO ENDPOINT
r.get("/all", config_controller_1.getAllConfigs);
r.post("/reset", config_controller_1.resetConfig);
r.delete("/", config_controller_1.resetConfigDelete);
r.delete("/:id", config_controller_1.deleteConfig);
exports.default = r;

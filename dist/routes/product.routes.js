"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/product.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const ctrl = __importStar(require("../controllers/product.controller"));
const upload_1 = require("../middleware/upload");
const r = (0, express_1.Router)();
// 🔐 Todo requiere JWT
r.use(auth_middleware_1.verificarJWT);
// CRUD
r.post('/', ctrl.createProduct);
r.get('/', ctrl.listProducts);
r.get('/:id', ctrl.getProduct);
r.put('/:id', ctrl.updateProduct);
r.delete('/:id', ctrl.deleteProduct);
// Imágenes (Cloudflare Images)
r.post('/:id/images/upload', upload_1.uploadImageMem.single('file'), ctrl.uploadProductImage);
r.get('/:id/images', ctrl.listProductImages);
r.put('/:id/images/:imageId/primary', ctrl.setPrimaryImage);
r.delete('/:id/images/:imageId', ctrl.deleteImage);
exports.default = r;

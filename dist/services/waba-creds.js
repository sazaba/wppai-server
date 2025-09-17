"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWabaCredsByEmpresa = getWabaCredsByEmpresa;
const prisma_1 = __importDefault(require("../lib/prisma"));
async function getWabaCredsByEmpresa(empresaId) {
    const acc = await prisma_1.default.whatsappAccount.findUnique({ where: { empresaId } });
    if (!acc?.accessToken || !acc?.wabaId) {
        throw new Error('Cuenta de WhatsApp no conectada o falta wabaId.');
    }
    return { accessToken: acc.accessToken, wabaId: acc.wabaId };
}

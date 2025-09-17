"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasOverlap = hasOverlap;
// src/controllers/_availability.ts
const prisma_1 = __importDefault(require("../lib/prisma"));
/**
 * ¿Existe una cita que solape con [startAt, endAt)?
 * Regla: (a.start < b.end) && (a.end > b.start)
 */
async function hasOverlap(args) {
    const { empresaId, startAt, endAt, ignoreId } = args;
    const conflict = await prisma_1.default.appointment.findFirst({
        where: {
            empresaId,
            ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
            AND: [
                { startAt: { lt: endAt } }, // a.start < b.end
                { endAt: { gt: startAt } } // a.end > b.start
            ],
        },
        select: { id: true },
    });
    return Boolean(conflict);
}

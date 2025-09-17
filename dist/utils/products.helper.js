"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveRelevantProducts = retrieveRelevantProducts;
const prisma_1 = __importDefault(require("../lib/prisma"));
async function retrieveRelevantProducts(empresaId, query, k = 5) {
    const q = (query || '').trim();
    if (!q)
        return [];
    const where = {
        empresaId,
        disponible: true,
        OR: [
            { nombre: { contains: q } },
            { descripcion: { contains: q } },
            { beneficios: { contains: q } },
            { caracteristicas: { contains: q } },
        ],
    };
    const found = await prisma_1.default.product.findMany({
        where,
        include: { imagenes: true },
        take: Math.max(k * 2, k),
    });
    // Rankeo naïve
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = found
        .map((p) => {
        const text = [
            p.nombre ?? '',
            p.descripcion ?? '',
            p.beneficios ?? '',
            p.caracteristicas ?? '',
        ].join(' ').toLowerCase();
        const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
        return { p, score };
    })
        .sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.p);
}

// src/utils/products.helper.ts
import type { Prisma } from '@prisma/client'
import prisma from '../lib/prisma'

type ProductWithImages = Prisma.ProductGetPayload<{
    include: { imagenes: true }
}>

export async function retrieveRelevantProducts(
    empresaId: number,
    query: string,
    k = 5
): Promise<ProductWithImages[]> {
    const q = (query || '').trim()
    if (!q) return []

    const where: Prisma.ProductWhereInput = {
        empresaId,
        disponible: true,
        OR: [
            { nombre: { contains: q } },
            { descripcion: { contains: q } },
            { beneficios: { contains: q } },
            { caracteristicas: { contains: q } },
        ],
    }

    const found = await prisma.product.findMany({
        where,
        include: { imagenes: true },
        take: Math.max(k * 2, k),
    })

    // Rankeo naïve
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)

    const scored = found
        .map((p) => {
            const text = [
                p.nombre ?? '',
                p.descripcion ?? '',
                p.beneficios ?? '',
                p.caracteristicas ?? '',
            ].join(' ').toLowerCase()

            const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0)
            return { p, score }
        })
        .sort((a, b) => b.score - a.score)

    return scored.slice(0, k).map((s) => s.p)
}

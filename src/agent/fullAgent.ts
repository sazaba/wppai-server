// server/src/agent/fullAgent.ts
import prisma from '../lib/prisma'

export type AgentDecision = {
    action?: 'images'
    query?: string
    products?: Array<{ id: number; nombre: string }>
}

function nrm(t: string): string {
    return String(t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

const WANTS_IMAGES = [
    'foto', 'fotos', 'imagen', 'imagenes',
    'ver foto', 'ver imagen', 'muestra foto',
    'mandame fotos', 'enviame fotos', 'envíame fotos'
].map(nrm)

/**
 * Full Agent minimal:
 * - Detecta intención de "fotos"
 * - Busca productos relevantes (nombre/descripcion/beneficios/caracteristicas)
 * - Devuelve `action: 'images'` + lista de productos (id, nombre)
 */
export async function runFullAgent(args: {
    empresaId: number
    userText: string
}): Promise<AgentDecision> {
    const { empresaId, userText } = args
    const text = nrm(userText)

    // 1) ¿pide fotos?
    const wantsImages = WANTS_IMAGES.some(k => text.includes(k))
    if (!wantsImages) return {}

    // 2) construir una consulta simple con las palabras "fuertes"
    const tokens = text.split(' ').filter(w => w.length >= 3 && !WANTS_IMAGES.includes(w))
    const query = tokens.join(' ').trim()

    // 3) buscar productos (fallback si query queda vacía: primero del catálogo)
    let prods: Array<{ id: number; nombre: string }> = []

    if (query) {
        // MySQL suele ser case-insensitive por collation; si no, el nrm ayuda.
        // Buscamos por OR en campos relevantes.
        prods = await prisma.product.findMany({
            where: {
                empresaId,
                disponible: true,
                OR: [
                    { nombre: { contains: query } },
                    { descripcion: { contains: query } },
                    { beneficios: { contains: query } },
                    { caracteristicas: { contains: query } },
                ]
            },
            select: { id: true, nombre: true },
            take: 6,
            orderBy: { id: 'asc' }
        })
    }

    if (!prods.length) {
        prods = await prisma.product.findMany({
            where: { empresaId, disponible: true },
            select: { id: true, nombre: true },
            take: 3,
            orderBy: { id: 'asc' }
        })
    }

    if (!prods.length) return {}

    return { action: 'images', query, products: prods.slice(0, 3) }
}

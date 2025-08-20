// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'

// helper para parsear ids
const toInt = (v: unknown): number => {
    const n = Number.parseInt(String(v), 10)
    return Number.isNaN(n) ? 0 : n
}

export async function createProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const {
        nombre,
        descripcion = '',
        beneficios = '',
        caracteristicas = '',
        precioDesde,
    } = req.body

    const slug = nombre
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]/g, '')

    const p = await prisma.product.create({
        data: {
            empresaId,
            nombre,
            slug,
            descripcion: descripcion ?? '',
            beneficios: beneficios ?? '',
            caracteristicas: caracteristicas ?? '',
            precioDesde: precioDesde ?? null,
        },
    })

    res.status(201).json(p)
}

export async function addImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const { url, alt = '' } = req.body

    const product = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const img = await prisma.productImage.create({
        data: { productId: product.id, url, alt },
    })
    res.status(201).json(img)
}

export async function listProducts(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const q = (req.query.q as string | undefined)?.trim()

    const where: any = { empresaId }
    if (q) {
        where.OR = [
            { nombre: { contains: q, mode: 'insensitive' } },
            { descripcion: { contains: q, mode: 'insensitive' } },
            { beneficios: { contains: q, mode: 'insensitive' } },
            { caracteristicas: { contains: q, mode: 'insensitive' } },
        ]
    }

    const items = await prisma.product.findMany({
        where,
        include: { imagenes: { orderBy: { id: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
    })
    res.json(items)
}

export async function getProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params

    const item = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
        include: { imagenes: true },
    })
    if (!item) return res.status(404).json({ error: 'Producto no encontrado' })
    res.json(item)
}

export async function updateProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const data = req.body

    const exists = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
    })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })

    const updated = await prisma.product.update({
        where: { id: Number(id) },
        data: {
            nombre: data?.nombre ?? exists.nombre,
            descripcion: data?.descripcion ?? exists.descripcion,
            beneficios: data?.beneficios ?? exists.beneficios,
            caracteristicas: data?.caracteristicas ?? exists.caracteristicas,
            precioDesde:
                typeof data?.precioDesde === 'number' || data?.precioDesde === null
                    ? data.precioDesde
                    : exists.precioDesde,
        },
    })
    res.json(updated)
}

export async function deleteProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params

    const exists = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
    })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })

    // si tu FK no tiene CASCADE, mantenemos esta limpieza explícita
    await prisma.productImage.deleteMany({ where: { productId: Number(id) } })
    await prisma.product.delete({ where: { id: Number(id) } })

    res.status(204).end()
}

/**
 * DELETE /api/products/:id/images/:imageId
 * Borra una imagen validando:
 *  - que la imagen existe
 *  - que pertenece al producto indicado
 *  - que el producto pertenece a la empresa del usuario
 */
export async function deleteImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    // Tipamos params para evitar el error de TS: Property 'imageId' does not exist on type 'ParamsDictionary'
    const { id, imageId } = req.params as unknown as { id: string; imageId: string }

    const productId = toInt(id)
    const imgId = toInt(imageId)

    // Validamos primero que el producto es de la empresa
    const product = await prisma.product.findFirst({
        where: { id: productId, empresaId },
        select: { id: true },
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    // Borrado robusto: exige coincidir id + productId (y por seguridad validamos empresa vía relación)
    const result = await prisma.productImage.deleteMany({
        where: {
            id: imgId,
            productId: productId,
            product: { empresaId }, // filtro relacional extra por seguridad multiempresa
        },
    })

    if (result.count === 0) {
        return res
            .status(404)
            .json({ error: 'Imagen no encontrada para este producto' })
    }

    res.status(204).end()
}

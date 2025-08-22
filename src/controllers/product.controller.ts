// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import sharp from 'sharp'
import { r2DeleteObject, r2PutObject, makeObjectKeyForProduct } from '../lib/r2'
import { StorageProvider } from '@prisma/client'


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
    const { id, imageId } = req.params as unknown as { id: string; imageId: string }

    const productId = toInt(id)
    const imgId = toInt(imageId)

    // Trae la imagen verificando pertenencia a empresa vía relación
    const img = await prisma.productImage.findFirst({
        where: { id: imgId, productId, product: { empresaId } },
    })

    if (!img) {
        return res.status(404).json({ error: 'Imagen no encontrada para este producto' })
    }

    // Borra en R2 si corresponde (no falla la operación si no se puede borrar remoto)
    if (img.provider === StorageProvider.r2 && img.objectKey) {
        try {
            await r2DeleteObject(img.objectKey)
        } catch (e) {
            console.warn('[deleteImage] No se pudo borrar en R2, se continuará con DB:', e)
        }
    }

    await prisma.productImage.delete({ where: { id: img.id } })
    res.status(204).end()
}

// ========================
// SUBIR IMAGEN A R2  (POST /api/products/:id/images)
// Body: multipart/form-data -> field 'file'; opcional: alt, isPrimary="true|false"
// ========================
export async function uploadProductImageR2(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    if (!req.file) {
        return res.status(400).json({ error: "No file received. Use field 'file'." })
    }

    // Validar producto pertenece a la empresa
    const product = await prisma.product.findFirst({ where: { id: productId, empresaId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const alt = (req.body?.alt as string) || ''
    const isPrimary = String(req.body?.isPrimary || '').toLowerCase() === 'true'

    // Meta de imagen (no bloqueante si falla)
    let width: number | undefined
    let height: number | undefined
    try {
        const meta = await sharp(req.file.buffer).metadata()
        width = meta.width
        height = meta.height
    } catch { /* ignore */ }

    const objectKey = makeObjectKeyForProduct(productId, req.file.originalname)
    const mimeType = req.file.mimetype
    const sizeBytes = req.file.size

    // Sube a R2
    let publicUrl: string
    try {
        publicUrl = await r2PutObject(objectKey, req.file.buffer, mimeType)
    } catch (e) {
        console.error('[uploadProductImageR2] r2PutObject error:', e)
        return res.status(500).json({ error: 'Error subiendo a R2' })
    }

    // Guarda en DB (si isPrimary=true desmarca otras dentro de la misma tx)
    const img = await prisma.$transaction(async (tx) => {
        if (isPrimary) {
            await tx.productImage.updateMany({
                where: { productId, isPrimary: true },
                data: { isPrimary: false },
            })
        }
        return tx.productImage.create({
            data: {
                productId,
                url: publicUrl,
                alt,
                provider: 'r2',
                objectKey,
                mimeType,
                sizeBytes,
                width,
                height,
                isPrimary,
            },
        })
    })

    return res.status(201).json({
        id: img.id,
        url: img.url,
        objectKey: img.objectKey,
        isPrimary: img.isPrimary,
        mimeType: img.mimeType,
        sizeBytes: img.sizeBytes,
        width: img.width,
        height: img.height,
        provider: img.provider,
    })
}

// ========================
// LISTAR IMÁGENES (GET /api/products/:id/images)
// ========================
export async function listProductImages(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    const product = await prisma.product.findFirst({ where: { id: productId, empresaId }, select: { id: true } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const images = await prisma.productImage.findMany({
        where: { productId },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    })
    res.json(images)
}

// ========================
// SET PRIMARY (PUT /api/products/:id/images/:imageId/primary)
// ========================
export async function setPrimaryImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)
    const imageId = toInt(req.params.imageId)

    const product = await prisma.product.findFirst({ where: { id: productId, empresaId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const img = await prisma.productImage.findFirst({
        where: { id: imageId, productId, product: { empresaId } },
    })
    if (!img) return res.status(404).json({ error: 'Imagen no encontrada para este producto' })

    await prisma.$transaction([
        prisma.productImage.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } }),
        prisma.productImage.update({ where: { id: imageId }, data: { isPrimary: true } }),
    ])

    res.status(204).end()
}

// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import sharp from 'sharp'
import {
    r2DeleteObject,
    r2PutObject,
    makeObjectKeyForProduct,
    publicR2Url,
} from '../lib/r2'
import { StorageProvider } from '@prisma/client'

// ---------------------- utils ----------------------
const toInt = (v: unknown): number => {
    const n = Number.parseInt(String(v), 10)
    return Number.isNaN(n) ? 0 : n
}

/** Normaliza el nombre a slug seguro */
function slugify(name: string) {
    return (name || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
}

/** slug único global (índice único en DB) */
async function ensureUniqueSlug(base: string) {
    let candidate = base || 'producto'
    let i = 2
    while (true) {
        const exists = await prisma.product.findFirst({
            where: { slug: candidate },
            select: { id: true },
        })
        if (!exists) return candidate
        candidate = `${base}-${i++}`
    }
}

/** Siempre devuelve una URL pública para el navegador */
function normalizeImageUrl(img: {
    url: string | null
    objectKey: string | null
}): string {
    // Si ya hay una URL absoluta, úsala
    if (img.url && /^https?:\/\//i.test(img.url)) return img.url
    // Si tenemos objectKey, la convertimos a URL pública de R2
    if (img.objectKey) return publicR2Url(img.objectKey)
    // Último recurso (puede quedar rota, pero no rompe la app)
    return img.url || ''
}

// ---------------------- CRUD productos ----------------------
export async function createProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const {
        nombre,
        descripcion = '',
        beneficios = '',
        caracteristicas = '',
        precioDesde,
    } = req.body

    if (!nombre || !String(nombre).trim()) {
        return res.status(400).json({ error: 'El producto necesita un nombre.' })
    }

    const baseSlug = slugify(nombre)
    let slug = await ensureUniqueSlug(baseSlug)

    try {
        const p = await prisma.product.create({
            data: {
                empresaId,
                nombre,
                slug,
                descripcion,
                beneficios,
                caracteristicas,
                precioDesde: precioDesde ?? null,
            },
        })
        return res.status(201).json(p)
    } catch (err: any) {
        if (err?.code === 'P2002') {
            slug = await ensureUniqueSlug(baseSlug)
            const p = await prisma.product.create({
                data: {
                    empresaId,
                    nombre,
                    slug,
                    descripcion,
                    beneficios,
                    caracteristicas,
                    precioDesde: precioDesde ?? null,
                },
            })
            return res.status(201).json(p)
        }
        console.error('[createProduct] error:', err)
        return res.status(500).json({ error: 'No se pudo crear el producto.' })
    }
}

// (opcional antiguo) insertar imagen por URL directa
export async function addImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const { url, alt = '' } = req.body

    const product = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const img = await prisma.productImage.create({
        data: { productId: product.id, url, alt, provider: 'external' as StorageProvider },
    })
    res.status(201).json({
        ...img,
        url: normalizeImageUrl(img),
    })
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

    // Normalizamos URLs públicas de imágenes
    const payload = items.map((p) => ({
        ...p,
        imagenes: p.imagenes.map((img) => ({
            ...img,
            url: normalizeImageUrl(img),
        })),
    }))

    res.json(payload)
}

export async function getProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params

    const item = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
        include: { imagenes: { orderBy: { id: 'asc' } } },
    })
    if (!item) return res.status(404).json({ error: 'Producto no encontrado' })

    const payload = {
        ...item,
        imagenes: item.imagenes.map((img) => ({
            ...img,
            url: normalizeImageUrl(img),
        })),
    }

    res.json(payload)
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
        include: { imagenes: { orderBy: { id: 'asc' } } },
    })

    const payload = {
        ...updated,
        imagenes: updated.imagenes.map((img) => ({
            ...img,
            url: normalizeImageUrl(img),
        })),
    }

    res.json(payload)
}

export async function deleteProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const productId = Number(id)

    const exists = await prisma.product.findFirst({
        where: { id: productId, empresaId },
        include: { imagenes: true },
    })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })

    // Borrar objetos en R2 si aplica (antes de borrar en DB)
    for (const img of exists.imagenes) {
        if (img.provider === 'r2' && img.objectKey) {
            try {
                await r2DeleteObject(img.objectKey)
            } catch (e) {
                console.warn('[deleteProduct] no se pudo borrar en R2:', img.objectKey, e)
            }
        }
    }

    await prisma.productImage.deleteMany({ where: { productId } })
    await prisma.product.delete({ where: { id: productId } })

    res.status(204).end()
}

/**
 * DELETE /api/products/:id/images/:imageId
 * Borra una imagen validando pertenencia
 */
export async function deleteImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id, imageId } = req.params as unknown as { id: string; imageId: string }

    const productId = Number.parseInt(id, 10) || 0
    const imgId = Number.parseInt(imageId, 10) || 0

    const img = await prisma.productImage.findFirst({
        where: { id: imgId, productId, product: { empresaId } },
    })
    if (!img) return res.status(404).json({ error: 'Imagen no encontrada para este producto' })

    if (img.provider === 'r2' && img.objectKey) {
        try {
            await r2DeleteObject(img.objectKey)
        } catch (e) {
            console.warn('[deleteImage] R2 delete falló, continuamos:', e)
        }
    }

    await prisma.productImage.delete({ where: { id: img.id } })
    res.status(204).end()
}

// ========================
// POST /api/products/:id/images (multipart: field "file"; opcional alt, isPrimary)
// ========================
export async function uploadProductImageR2(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    if (!req.file) {
        return res.status(400).json({ error: "No file received. Use field 'file'." })
    }

    const product = await prisma.product.findFirst({ where: { id: productId, empresaId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const alt = (req.body?.alt as string) || ''
    const isPrimary = String(req.body?.isPrimary || '').toLowerCase() === 'true'

    // Meta (no bloqueante)
    let width: number | undefined
    let height: number | undefined
    try {
        const meta = await sharp(req.file.buffer).metadata()
        width = meta.width
        height = meta.height
    } catch { /* ignore */ }

    const mimeType = req.file.mimetype
    const sizeBytes = req.file.size

    // Subida a R2 directa
    let publicUrl: string
    let objectKeyStored: string

    try {
        const objectKey = makeObjectKeyForProduct(productId, req.file.originalname)
        publicUrl = await r2PutObject(objectKey, req.file.buffer, mimeType)
        objectKeyStored = objectKey
    } catch (e) {
        console.error('[uploadProductImageR2] upload error:', e)
        return res.status(500).json({ error: 'Error subiendo imagen' })
    }

    // Persistir imagen; si es primaria, desmarcar otras
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
                url: publicUrl,                    // guardamos URL pública
                objectKey: objectKeyStored,        // guardamos key para poder regenerar URL si cambia el dominio
                alt,
                provider: 'r2' as StorageProvider,
                mimeType,
                sizeBytes,
                width,
                height,
                isPrimary,
            },
        })
    })

    // Respondemos con la URL pública (preview inmediato)
    return res.status(201).json({
        id: img.id,
        url: normalizeImageUrl(img),
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
// GET /api/products/:id/images
// ========================
export async function listProductImages(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    const product = await prisma.product.findFirst({
        where: { id: productId, empresaId },
        select: { id: true },
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const images = await prisma.productImage.findMany({
        where: { productId },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    })

    res.json(
        images.map((img) => ({
            ...img,
            url: normalizeImageUrl(img),
        }))
    )
}

// ========================
// PUT /api/products/:id/images/:imageId/primary
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
        prisma.productImage.updateMany({
            where: { productId, isPrimary: true },
            data: { isPrimary: false },
        }),
        prisma.productImage.update({ where: { id: imageId }, data: { isPrimary: true } }),
    ])

    res.status(204).end()
}

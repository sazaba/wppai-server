// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import sharp from 'sharp'
import { r2DeleteObject, r2PutObject, makeObjectKeyForProduct, publicR2Url } from '../lib/r2'
import { StorageProvider } from '@prisma/client'

// helper para parsear ids
const toInt = (v: unknown): number => {
    const n = Number.parseInt(String(v), 10)
    return Number.isNaN(n) ? 0 : n
}

/** Normaliza el nombre a slug seguro */
function slugify(name: string) {
    return (name || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quita acentos
        .replace(/[^\w\s-]/g, '')                           // solo letras/números/_/espacios/-
        .trim()
        .replace(/\s+/g, '-')                               // espacios -> guiones
        .replace(/-+/g, '-')                                // colapsa guiones
}

/** Busca un slug disponible (global, porque tu índice único es global) */
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
        // por si hay carrera y alguien tomó el mismo slug justo antes
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

    const productId = Number.parseInt(id, 10) || 0
    const imgId = Number.parseInt(imageId, 10) || 0

    // Trae la imagen verificando pertenencia a empresa vía relación
    const img = await prisma.productImage.findFirst({
        where: { id: imgId, productId, product: { empresaId } },
    })
    if (!img) return res.status(404).json({ error: 'Imagen no encontrada para este producto' })

    // si fue subida a R2, intentamos borrarla también en el storage
    if (img.provider === 'r2' && img.objectKey) {
        try {
            if (process.env.USE_R2_WORKER === '1') {
                const { deleteFromR2ViaWorker } = await import('../lib/r2-worker')
                await deleteFromR2ViaWorker(img.objectKey)
            } else {
                await r2DeleteObject(img.objectKey)
            }
        } catch (e) {
            console.warn('[deleteImage] R2 delete falló, continuamos:', e)
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

    const mimeType = req.file.mimetype
    const sizeBytes = req.file.size

    // Sube a R2 (vía Worker si está activo)
    let publicUrl: string
    let objectKeyStored: string

    try {
        if (process.env.USE_R2_WORKER === '1') {
            const { uploadToR2ViaWorker } = await import('../lib/r2-worker')
            const result = await uploadToR2ViaWorker({
                productId,
                buffer: req.file.buffer,
                filename: req.file.originalname,
                contentType: mimeType,
                alt,
                isPrimary,
            })
            // AUNQUE el worker devuelva una publicUrl, la forzamos con nuestra base:
            objectKeyStored = result.objectKey
            publicUrl = publicR2Url(objectKeyStored)
        } else {
            const objectKey = makeObjectKeyForProduct(productId, req.file.originalname)
            await r2PutObject(objectKey, req.file.buffer, mimeType)
            objectKeyStored = objectKey
            publicUrl = publicR2Url(objectKeyStored)
        }
    } catch (e) {
        console.error('[uploadProductImageR2] upload error:', e)
        return res.status(500).json({ error: 'Error subiendo imagen' })
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
                provider: 'r2' as StorageProvider,
                objectKey: objectKeyStored,
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

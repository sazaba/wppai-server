// server/src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import sharp from 'sharp'
import {
    r2DeleteObject,
    r2PutObject,
    makeObjectKeyForProduct,
    resolveR2Url,
} from '../lib/r2'
import { StorageProvider } from '@prisma/client'
import { getSignedPutUrl } from '../lib/r2'

// helper para parsear ids
const toInt = (v: unknown): number => {
    const n = Number.parseInt(String(v), 10)
    return Number.isNaN(n) ? 0 : n
}

/** Normaliza el nombre a slug seguro */
function slugify(name: string) {
    return (name || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
}

/** Busca un slug disponible (global) */
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

/** Decora imágenes generando la URL de vista (firmada si R2_SIGNED_GET=1) */
async function decorateImagesWithSignedUrl<
    T extends { objectKey: string | null; url: string }
>(imgs: T[]) {
    return Promise.all(
        imgs.map(async (img) => {
            const key = img.objectKey
            const viewUrl = key ? await resolveR2Url(key) : img.url
            return { ...img, url: viewUrl }
        })
    )
}

// ========================
// CRUD PRODUCTOS
// ========================
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

    const withSigned = await Promise.all(
        items.map(async (p) => ({
            ...p,
            imagenes: await decorateImagesWithSignedUrl(p.imagenes || []),
        }))
    )
    res.json(withSigned)
}

export async function getProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params

    const item = await prisma.product.findFirst({
        where: { id: Number(id), empresaId },
        include: { imagenes: true },
    })
    if (!item) return res.status(404).json({ error: 'Producto no encontrado' })

    const imagenes = await decorateImagesWithSignedUrl(item.imagenes || [])
    res.json({ ...item, imagenes })
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

    await prisma.productImage.deleteMany({ where: { productId: Number(id) } })
    await prisma.product.delete({ where: { id: Number(id) } })

    res.status(204).end()
}

// ========================
// IMÁGENES
// ========================
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

// SUBIR IMAGEN A R2  (POST /api/products/:id/images/upload)
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

    let width: number | undefined, height: number | undefined
    try {
        const meta = await sharp(req.file.buffer).metadata()
        width = meta.width
        height = meta.height
    } catch { /* ignore */ }

    const mimeType = req.file.mimetype
    const sizeBytes = req.file.size

    let urlParaVer: string
    let objectKeyStored: string

    try {
        const objectKey = makeObjectKeyForProduct(productId, req.file.originalname)
        await r2PutObject(objectKey, req.file.buffer, mimeType)
        objectKeyStored = objectKey
        urlParaVer = await resolveR2Url(objectKeyStored)
    } catch (e) {
        console.error('[uploadProductImageR2] upload error:', e)
        return res.status(500).json({ error: 'Error subiendo imagen' })
    }

    console.log('[R2 upload OK]', {
        objectKeyStored,
        urlSample: urlParaVer.slice(0, 160),
    })

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
                url: urlParaVer,
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

// LISTAR IMÁGENES (GET /api/products/:id/images)
export async function listProductImages(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    const product = await prisma.product.findFirst({
        where: { id: productId, empresaId },
        select: { id: true }
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const images = await prisma.productImage.findMany({
        where: { productId },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    })

    const withViewUrl = await decorateImagesWithSignedUrl(images)
    res.json(withViewUrl)
}

// SET PRIMARY (PUT /api/products/:id/images/:imageId/primary)
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

// ========================
// STREAM PÚBLICO → REDIRECT 302 A URL (firmada)
// GET /api/products/:id/images/:file
// ========================
export async function streamProductImagePublic(req: Request, res: Response) {
    const productId = Number.parseInt(String(req.params.id || ''), 10) || 0
    const file = String(req.params.file || '')

    if (!productId || !file) return res.status(404).end()

    const img = await prisma.productImage.findFirst({
        where: { productId, objectKey: { endsWith: `/${file}` } },
        select: { objectKey: true },
    })
    if (!img?.objectKey) return res.status(404).end()

    try {
        const signed = await resolveR2Url(img.objectKey, { expiresSec: 60 })
        res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60')
        return res.redirect(302, signed)
    } catch (e) {
        console.error('[streamProductImagePublic] error firmando URL:', e)
        return res.status(500).end()
    }
}

// POST /api/products/:id/images/presign
export async function presignProductImageUpload(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)
    const { filename, mimeType } = req.body || {}

    if (!productId || !filename) {
        return res.status(400).json({ error: "filename requerido" })
    }

    // verifica pertenencia del producto
    const product = await prisma.product.findFirst({ where: { id: productId, empresaId }, select: { id: true } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const objectKey = makeObjectKeyForProduct(productId, filename)
    try {
        const url = await getSignedPutUrl(objectKey, mimeType || 'application/octet-stream', 300)
        return res.json({ objectKey, url, expiresIn: 300 })
    } catch (e) {
        console.error('[presignProductImageUpload] error:', e)
        return res.status(500).json({ error: 'No se pudo firmar URL de subida' })
    }
}

// 👉 NUEVO: confirma subida (guarda en DB) luego de que el browser hizo el PUT a R2
// POST /api/products/:id/images/confirm
export async function confirmProductImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    const {
        objectKey,
        alt = '',
        isPrimary = false,
        mimeType,
        sizeBytes,
        width,
        height,
    } = req.body || {}

    if (!objectKey) return res.status(400).json({ error: 'objectKey requerido' })

    const product = await prisma.product.findFirst({ where: { id: productId, empresaId }, select: { id: true } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    try {
        const viewUrl = await resolveR2Url(objectKey) // pública o firmada según tu env

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
                    url: viewUrl,
                    alt,
                    provider: 'r2',
                    objectKey,
                    mimeType: mimeType || null,
                    sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : null,
                    width: typeof width === 'number' ? width : null,
                    height: typeof height === 'number' ? height : null,
                    isPrimary: !!isPrimary,
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
    } catch (e) {
        console.error('[confirmProductImage] error:', e)
        return res.status(500).json({ error: 'No se pudo confirmar la imagen' })
    }
}
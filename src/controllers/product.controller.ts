// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import sharp from 'sharp'
import { r2DeleteObject, r2PutObject, makeObjectKeyForProduct, resolveR2Url } from '../lib/r2'
import { StorageProvider } from '@prisma/client'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

// ---- R2 SDK (para el proxy de lectura) ----
const r2 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, // p.ej. https://<accountid>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
})

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

/** Decora imágenes generando la URL de vista (firmada si R2_SIGNED_GET=1) */
async function decorateImagesWithSignedUrl<
    T extends { objectKey: string | null; url: string }
>(imgs: T[]) {
    return Promise.all(
        imgs.map(async (img) => {
            const key = img.objectKey
            const viewUrl = key ? await resolveR2Url(key) : img.url // fallback si falta key
            return { ...img, url: viewUrl }
        })
    )
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

    // firmar URLs en cada producto (si hay objectKey)
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
    let width: number | undefined, height: number | undefined
    try {
        const meta = await sharp(req.file.buffer).metadata()
        width = meta.width
        height = meta.height
    } catch { /* ignore */ }

    const mimeType = req.file.mimetype
    const sizeBytes = req.file.size

    // Sube a R2 (vía Worker si está activo)
    let urlParaVer: string   // <- puede ser firmada o pública (según env)
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
            // aunque el worker devuelva una URL, generamos la nuestra (respeta R2_SIGNED_GET)
            objectKeyStored = result.objectKey
            urlParaVer = await resolveR2Url(objectKeyStored)
        } else {
            const objectKey = makeObjectKeyForProduct(productId, req.file.originalname)
            await r2PutObject(objectKey, req.file.buffer, mimeType)
            objectKeyStored = objectKey
            urlParaVer = await resolveR2Url(objectKeyStored)
        }
    } catch (e) {
        console.error('[uploadProductImageR2] upload error:', e)
        return res.status(500).json({ error: 'Error subiendo imagen' })
    }

    // log temporal para verificar firma
    console.log('[R2 upload OK]', {
        objectKeyStored,
        urlSample: urlParaVer.slice(0, 160),
    })

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
                url: urlParaVer,                  // <- vista (firmada si R2_SIGNED_GET=1)
                alt,
                provider: 'r2' as StorageProvider,
                objectKey: objectKeyStored,       // <- clave real en el bucket
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

// ======================================================================
// NUEVO: STREAM (PROXY) DE IMAGEN DESDE R2
// GET /api/products/:id/images/:file
// ======================================================================
export async function streamProductImagePublic(req: Request, res: Response) {
    const productId = Number.parseInt(String(req.params.id || ''), 10) || 0
    const file = String(req.params.file || '')

    if (!productId || !file) return res.status(404).end()

    // Buscamos por objectKey (termina en /<file>) y productId
    const img = await prisma.productImage.findFirst({
        where: {
            productId,
            objectKey: { endsWith: `/${file}` },
        },
    })
    if (!img || !img.objectKey) return res.status(404).end()

    try {
        const cmd = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET!,
            Key: img.objectKey,
        })
        const obj = await r2.send(cmd)

        res.setHeader('Content-Type', (obj.ContentType as string) || img.mimeType || 'application/octet-stream')
        // cachea 1h + SWR (ajústalo a tu gusto)
        res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')

        // @ts-ignore Body es Readable
        obj.Body.pipe(res)
    } catch (e) {
        console.error('[streamProductImagePublic] error:', e)
        res.status(500).end()
    }
}
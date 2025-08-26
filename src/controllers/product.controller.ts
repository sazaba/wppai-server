// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import { cfImagesUpload, cfImagesDelete, cfImageUrl } from '../lib/cloudflareImages'
import { StorageProvider } from '@prisma/client'

// 🔧 Ajusta aquí el nombre del variant que tengas creado en Cloudflare Images
const CF_VARIANT = process.env.CF_IMAGES_VARIANT || 'public'

// Helper para parsear IDs
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

export async function listProducts(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId

    const productos = await prisma.product.findMany({
        where: { empresaId },
        include: {
            imagenes: {
                orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
                select: {
                    id: true,
                    url: true,
                    alt: true,
                    imageId: true,
                    isPrimary: true,
                    provider: true,
                    createdAt: true,
                    updatedAt: true,
                    sortOrder: true,
                    productId: true,
                },
            },
        },
        orderBy: { createdAt: 'desc' },
    })

    // reescribimos la URL con el variant
    const out = productos.map((p) => ({
        ...p,
        imagenes: (p.imagenes || []).map((img) => ({
            ...img,
            url: cfImageUrl(img.imageId, CF_VARIANT),
        })),
    }))

    res.json(out)
}

export async function getProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const id = toInt(req.params.id)
    const producto = await prisma.product.findFirst({
        where: { id, empresaId },
        include: { imagenes: true },
    })
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' })
    res.json(producto)
}

export async function updateProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const id = toInt(req.params.id)
    const data = req.body
    const exists = await prisma.product.findFirst({ where: { id, empresaId } })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })
    const updated = await prisma.product.update({
        where: { id },
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
    const id = toInt(req.params.id)
    const exists = await prisma.product.findFirst({ where: { id, empresaId } })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })
    await prisma.productImage.deleteMany({ where: { productId: id } })
    await prisma.product.delete({ where: { id } })
    res.status(204).end()
}

// ========================
// IMÁGENES (Cloudflare Images)
// ========================

export async function uploadProductImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId as number
    const productId = toInt(req.params.id)

    if (!req.file) {
        return res.status(400).json({ error: "No file received. Use field 'file'." })
    }

    const product = await prisma.product.findFirst({ where: { id: productId, empresaId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })

    const alt = (req.body?.alt as string) || ''
    const isPrimary = String(req.body?.isPrimary || '').toLowerCase() === 'true'

    // Subida a Cloudflare Images
    let imageId: string
    try {
        const result = await cfImagesUpload(req.file.buffer, req.file.originalname)
        imageId = result.id
    } catch (e) {
        console.error('[uploadProductImage] Images upload error:', e)
        return res.status(500).json({ error: 'Error subiendo imagen' })
    }

    const urlParaVer = cfImageUrl(imageId, CF_VARIANT)

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
                provider: StorageProvider.cloudflare_image,
                imageId,
                isPrimary,
            },
        })
    })

    return res.status(201).json({
        id: img.id,
        url: img.url,
        alt: img.alt,
        imageId: img.imageId,
        isPrimary: img.isPrimary,
        provider: img.provider,
        updatedAt: img.updatedAt, // <- para cache-buster
    })
}

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

    const withViewUrl = images.map(img => ({
        id: img.id,
        url: cfImageUrl(img.imageId, CF_VARIANT),
        alt: img.alt,
        imageId: img.imageId,
        isPrimary: img.isPrimary,
        provider: img.provider,
        sortOrder: img.sortOrder,
        createdAt: img.createdAt,
        updatedAt: img.updatedAt, // <- importante
        productId: img.productId,
    }))

    res.json(withViewUrl)
}

export async function deleteImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id, imageId } = req.params as unknown as { id: string; imageId: string }

    const productId = Number.parseInt(id, 10) || 0
    const imgId = Number.parseInt(imageId, 10) || 0

    const img = await prisma.productImage.findFirst({
        where: { id: imgId, productId, product: { empresaId } },
    })
    if (!img) return res.status(404).json({ error: 'Imagen no encontrada para este producto' })

    if (img.provider === StorageProvider.cloudflare_image && img.imageId) {
        try {
            await cfImagesDelete(img.imageId)
        } catch (e) {
            console.warn('[deleteImage] Cloudflare Images delete falló, continuamos:', e)
        }
    }

    await prisma.productImage.delete({ where: { id: img.id } })
    res.status(204).end()
}

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

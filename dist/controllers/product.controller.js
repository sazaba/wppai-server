"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProduct = createProduct;
exports.listProducts = listProducts;
exports.getProduct = getProduct;
exports.updateProduct = updateProduct;
exports.deleteProduct = deleteProduct;
exports.uploadProductImage = uploadProductImage;
exports.listProductImages = listProductImages;
exports.deleteImage = deleteImage;
exports.setPrimaryImage = setPrimaryImage;
const prisma_1 = __importDefault(require("../lib/prisma"));
const cloudflareImages_1 = require("../lib/cloudflareImages");
const client_1 = require("@prisma/client");
// 🔧 Ajusta aquí el nombre del variant que tengas creado en Cloudflare Images
const CF_VARIANT = process.env.CF_IMAGES_VARIANT || 'public';
// Helper para parsear IDs
const toInt = (v) => {
    const n = Number.parseInt(String(v), 10);
    return Number.isNaN(n) ? 0 : n;
};
/** Normaliza el nombre a slug seguro */
function slugify(name) {
    return (name || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}
async function ensureUniqueSlug(base) {
    let candidate = base || 'producto';
    let i = 2;
    while (true) {
        const exists = await prisma_1.default.product.findFirst({
            where: { slug: candidate },
            select: { id: true },
        });
        if (!exists)
            return candidate;
        candidate = `${base}-${i++}`;
    }
}
// ========================
// CRUD PRODUCTOS
// ========================
async function createProduct(req, res) {
    const empresaId = req.user?.empresaId;
    const { nombre, descripcion = '', beneficios = '', caracteristicas = '', precioDesde, } = req.body;
    if (!nombre || !String(nombre).trim()) {
        return res.status(400).json({ error: 'El producto necesita un nombre.' });
    }
    const baseSlug = slugify(nombre);
    let slug = await ensureUniqueSlug(baseSlug);
    try {
        const p = await prisma_1.default.product.create({
            data: {
                empresaId,
                nombre,
                slug,
                descripcion,
                beneficios,
                caracteristicas,
                precioDesde: precioDesde ?? null,
            },
        });
        return res.status(201).json(p);
    }
    catch (err) {
        if (err?.code === 'P2002') {
            slug = await ensureUniqueSlug(baseSlug);
            const p = await prisma_1.default.product.create({
                data: {
                    empresaId,
                    nombre,
                    slug,
                    descripcion,
                    beneficios,
                    caracteristicas,
                    precioDesde: precioDesde ?? null,
                },
            });
            return res.status(201).json(p);
        }
        console.error('[createProduct] error:', err);
        return res.status(500).json({ error: 'No se pudo crear el producto.' });
    }
}
async function listProducts(req, res) {
    const empresaId = req.user?.empresaId;
    const productos = await prisma_1.default.product.findMany({
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
    });
    // reescribimos la URL con el variant
    const out = productos.map((p) => ({
        ...p,
        imagenes: (p.imagenes || []).map((img) => ({
            ...img,
            url: (0, cloudflareImages_1.cfImageUrl)(img.imageId, CF_VARIANT),
        })),
    }));
    res.json(out);
}
async function getProduct(req, res) {
    const empresaId = req.user?.empresaId;
    const id = toInt(req.params.id);
    const producto = await prisma_1.default.product.findFirst({
        where: { id, empresaId },
        include: { imagenes: true },
    });
    if (!producto)
        return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(producto);
}
async function updateProduct(req, res) {
    const empresaId = req.user?.empresaId;
    const id = toInt(req.params.id);
    const data = req.body;
    const exists = await prisma_1.default.product.findFirst({ where: { id, empresaId } });
    if (!exists)
        return res.status(404).json({ error: 'Producto no encontrado' });
    const updated = await prisma_1.default.product.update({
        where: { id },
        data: {
            nombre: data?.nombre ?? exists.nombre,
            descripcion: data?.descripcion ?? exists.descripcion,
            beneficios: data?.beneficios ?? exists.beneficios,
            caracteristicas: data?.caracteristicas ?? exists.caracteristicas,
            precioDesde: typeof data?.precioDesde === 'number' || data?.precioDesde === null
                ? data.precioDesde
                : exists.precioDesde,
        },
    });
    res.json(updated);
}
async function deleteProduct(req, res) {
    const empresaId = req.user?.empresaId;
    const id = toInt(req.params.id);
    const exists = await prisma_1.default.product.findFirst({ where: { id, empresaId } });
    if (!exists)
        return res.status(404).json({ error: 'Producto no encontrado' });
    await prisma_1.default.productImage.deleteMany({ where: { productId: id } });
    await prisma_1.default.product.delete({ where: { id } });
    res.status(204).end();
}
// ========================
// IMÁGENES (Cloudflare Images)
// ========================
async function uploadProductImage(req, res) {
    const empresaId = req.user?.empresaId;
    const productId = toInt(req.params.id);
    if (!req.file) {
        return res.status(400).json({ error: "No file received. Use field 'file'." });
    }
    const product = await prisma_1.default.product.findFirst({ where: { id: productId, empresaId } });
    if (!product)
        return res.status(404).json({ error: 'Producto no encontrado' });
    const alt = req.body?.alt || '';
    const isPrimary = String(req.body?.isPrimary || '').toLowerCase() === 'true';
    // Subida a Cloudflare Images
    let imageId;
    try {
        const result = await (0, cloudflareImages_1.cfImagesUpload)(req.file.buffer, req.file.originalname);
        imageId = result.id;
    }
    catch (e) {
        console.error('[uploadProductImage] Images upload error:', e);
        return res.status(500).json({ error: 'Error subiendo imagen' });
    }
    const urlParaVer = (0, cloudflareImages_1.cfImageUrl)(imageId, CF_VARIANT);
    const img = await prisma_1.default.$transaction(async (tx) => {
        if (isPrimary) {
            await tx.productImage.updateMany({
                where: { productId, isPrimary: true },
                data: { isPrimary: false },
            });
        }
        return tx.productImage.create({
            data: {
                productId,
                url: urlParaVer,
                alt,
                provider: client_1.StorageProvider.cloudflare_image,
                imageId,
                isPrimary,
            },
        });
    });
    return res.status(201).json({
        id: img.id,
        url: img.url,
        alt: img.alt,
        imageId: img.imageId,
        isPrimary: img.isPrimary,
        provider: img.provider,
        updatedAt: img.updatedAt, // <- para cache-buster
    });
}
async function listProductImages(req, res) {
    const empresaId = req.user?.empresaId;
    const productId = toInt(req.params.id);
    const product = await prisma_1.default.product.findFirst({
        where: { id: productId, empresaId },
        select: { id: true }
    });
    if (!product)
        return res.status(404).json({ error: 'Producto no encontrado' });
    const images = await prisma_1.default.productImage.findMany({
        where: { productId },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const withViewUrl = images.map(img => ({
        id: img.id,
        url: (0, cloudflareImages_1.cfImageUrl)(img.imageId, CF_VARIANT),
        alt: img.alt,
        imageId: img.imageId,
        isPrimary: img.isPrimary,
        provider: img.provider,
        sortOrder: img.sortOrder,
        createdAt: img.createdAt,
        updatedAt: img.updatedAt, // <- importante
        productId: img.productId,
    }));
    res.json(withViewUrl);
}
async function deleteImage(req, res) {
    const empresaId = req.user?.empresaId;
    const { id, imageId } = req.params;
    const productId = Number.parseInt(id, 10) || 0;
    const imgId = Number.parseInt(imageId, 10) || 0;
    const img = await prisma_1.default.productImage.findFirst({
        where: { id: imgId, productId, product: { empresaId } },
    });
    if (!img)
        return res.status(404).json({ error: 'Imagen no encontrada para este producto' });
    if (img.provider === client_1.StorageProvider.cloudflare_image && img.imageId) {
        try {
            await (0, cloudflareImages_1.cfImagesDelete)(img.imageId);
        }
        catch (e) {
            console.warn('[deleteImage] Cloudflare Images delete falló, continuamos:', e);
        }
    }
    await prisma_1.default.productImage.delete({ where: { id: img.id } });
    res.status(204).end();
}
async function setPrimaryImage(req, res) {
    const empresaId = req.user?.empresaId;
    const productId = toInt(req.params.id);
    const imageId = toInt(req.params.imageId);
    const product = await prisma_1.default.product.findFirst({ where: { id: productId, empresaId } });
    if (!product)
        return res.status(404).json({ error: 'Producto no encontrado' });
    const img = await prisma_1.default.productImage.findFirst({
        where: { id: imageId, productId, product: { empresaId } },
    });
    if (!img)
        return res.status(404).json({ error: 'Imagen no encontrada para este producto' });
    await prisma_1.default.$transaction([
        prisma_1.default.productImage.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } }),
        prisma_1.default.productImage.update({ where: { id: imageId }, data: { isPrimary: true } }),
    ]);
    res.status(204).end();
}

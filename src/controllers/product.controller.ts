// src/controllers/product.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'

export async function createProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { nombre, descripcion = '', beneficios = '', caracteristicas = '', precioDesde } = req.body
    const slug = nombre.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
    const p = await prisma.product.create({
        data: { empresaId, nombre, slug, descripcion, beneficios, caracteristicas, precioDesde: precioDesde ?? null }
    })
    res.json(p)
}

export async function addImage(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const { url, alt = '' } = req.body
    const product = await prisma.product.findFirst({ where: { id: Number(id), empresaId } })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' })
    const img = await prisma.productImage.create({ data: { productId: product.id, url, alt } })
    res.json(img)
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
    const items = await prisma.product.findMany({ where, include: { imagenes: true }, orderBy: { updatedAt: 'desc' } })
    res.json(items)
}

export async function getProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const item = await prisma.product.findFirst({ where: { id: Number(id), empresaId }, include: { imagenes: true } })
    if (!item) return res.status(404).json({ error: 'Producto no encontrado' })
    res.json(item)
}

export async function updateProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const data = req.body
    const exists = await prisma.product.findFirst({ where: { id: Number(id), empresaId } })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })
    const updated = await prisma.product.update({ where: { id: Number(id) }, data })
    res.json(updated)
}

export async function deleteProduct(req: Request, res: Response) {
    const empresaId = (req as any).user?.empresaId
    const { id } = req.params
    const exists = await prisma.product.findFirst({ where: { id: Number(id), empresaId } })
    if (!exists) return res.status(404).json({ error: 'Producto no encontrado' })
    await prisma.productImage.deleteMany({ where: { productId: Number(id) } })
    await prisma.product.delete({ where: { id: Number(id) } })
    res.json({ ok: true })
}

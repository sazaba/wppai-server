import { Request, Response } from "express";
import prisma from '../lib/prisma'

export async function listProviders(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const data = await prisma.provider.findMany({
        where: { empresaId, activo: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true },
    });
    res.json(data);
}

export async function createProvider(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const { nombre, cargo, email, phone, colorHex } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es requerido" });

    const p = await prisma.provider.create({
        data: { empresaId, nombre, cargo: cargo || "", email: email || "", phone: phone || "", colorHex: colorHex || "" },
    });
    res.status(201).json(p);
}

export async function updateProvider(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const id = Number(req.params.id);
    const { nombre, cargo, email, phone, colorHex, activo } = req.body;

    const p = await prisma.provider.update({
        where: { id },
        data: { nombre, cargo, email, phone, colorHex, activo },
    });
    if (p.empresaId !== empresaId) return res.status(403).json({ error: "forbidden" });
    res.json(p);
}

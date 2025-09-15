import { Request, Response } from "express";
import prisma from '../lib/prisma'
import { getEmpresaId } from "./_getEmpresaId";

export async function listServices(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const data = await prisma.service.findMany({
        where: { empresaId, activo: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true, duracionMin: true },
    });
    res.json(data);
}

export async function createService(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const { nombre, duracionMin, precioDesde } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es requerido" });

    const service = await prisma.service.create({
        data: { empresaId, nombre, duracionMin: Number(duracionMin ?? 30), precioDesde },
    });
    res.status(201).json(service);
}

export async function updateService(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const id = Number(req.params.id);
    const { nombre, duracionMin, precioDesde, activo } = req.body;

    const data = await prisma.service.update({
        where: { id },
        data: { nombre, duracionMin, precioDesde, activo },
    });
    if (data.empresaId !== empresaId) return res.status(403).json({ error: "forbidden" });
    res.json(data);
}

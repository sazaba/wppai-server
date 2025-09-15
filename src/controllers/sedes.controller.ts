import { Request, Response } from "express";
import prisma from '../lib/prisma'
import { getEmpresaId } from "./_getEmpresaId";

export async function listSedes(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const data = await prisma.sede.findMany({
        where: { empresaId, activo: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true, timezone: true },
    });
    res.json(data);
}

export async function createSede(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const { nombre, timezone, direccion } = req.body;
    if (!nombre) return res.status(400).json({ error: "nombre es requerido" });

    const sede = await prisma.sede.create({
        data: { empresaId, nombre, timezone: timezone || "America/Bogota", direccion: direccion || "" },
    });
    res.status(201).json(sede);
}

export async function updateSede(req: Request, res: Response) {
    const empresaId = getEmpresaId(req);
    const id = Number(req.params.id);
    const { nombre, timezone, direccion, activo } = req.body;

    const sede = await prisma.sede.update({
        where: { id },
        data: { nombre, timezone, direccion, activo },
    });
    if (sede.empresaId !== empresaId) return res.status(403).json({ error: "forbidden" });
    res.json(sede);
}

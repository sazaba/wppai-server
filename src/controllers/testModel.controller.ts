import { Request, Response } from "express";
import prisma from "../lib/prisma";
// 👇 Asegúrate de importar tu helper desde donde lo tengas guardado
import { getEmpresaId } from "./_getEmpresaId"; 

// ───────────────────────────────────────────────────────────────────────────────
// Crear registro
// ───────────────────────────────────────────────────────────────────────────────
export const crearTest = async (req: Request, res: Response) => {
    try {
        // ✅ USAMOS EL HELPER: Él se encarga de buscar el ID o lanzar error si no está
        const empresaId = getEmpresaId(req); 
        const { nombre } = req.body;

        if (!nombre) return res.status(400).json({ error: "Falta el nombre" });

        const creado = await prisma.testModel.create({
            data: {
                nombre,
                empresaId
            }
        });

        return res.status(201).json(creado);
    } catch (error: any) {
        // El helper lanza errores con status 400, los capturamos aquí
        if (error.status === 400) {
            return res.status(400).json({ error: error.message });
        }
        console.error("❌ Error al crear test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Listar registros
// ───────────────────────────────────────────────────────────────────────────────
export const listarTests = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const lista = await prisma.testModel.findMany({
            where: { empresaId },
            orderBy: { id: "desc" }
        });

        return res.json(lista);
    } catch (error: any) {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error("❌ Error al listar tests:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Obtener uno
// ───────────────────────────────────────────────────────────────────────────────
export const obtenerTest = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const id = Number(req.params.id);
        
        if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });

        const registro = await prisma.testModel.findFirst({
            where: { id, empresaId }
        });

        if (!registro) return res.status(404).json({ error: "No encontrado" });

        return res.json(registro);
    } catch (error: any) {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error("❌ Error al obtener test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// Eliminar registro
// ───────────────────────────────────────────────────────────────────────────────
export const eliminarTest = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const id = Number(req.params.id);
        
        if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });

        const existente = await prisma.testModel.findFirst({ where: { id, empresaId } });
        if (!existente) return res.status(404).json({ error: "Registro no encontrado" });

        await prisma.testModel.delete({ where: { id } });

        return res.json({ mensaje: "Eliminado correctamente" });
    } catch (error: any) {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error("❌ Error al eliminar test:", error);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
};
import { Request, Response } from "express"
import prisma from '../lib/prisma'

//
// 👉 CONTROLADOR: Guardar configuración del negocio
//
export async function saveConfig(req: Request, res: Response) {
    const {
        nombre,
        descripcion,
        servicios,
        faq,
        horarios,
        escalarSiNoConfia,
        escalarPalabrasClave,
        escalarPorReintentos
    } = req.body
    console.log('EMPRESA ID:', req.user?.empresaId)

    const empresaId = req.user?.empresaId as number


    if (!nombre || !descripcion || !servicios || !faq || !horarios) {
        return res.status(400).json({ error: "Todos los campos son requeridos." })
    }

    try {
        const config = await prisma.businessConfig.create({
            data: {
                nombre,
                descripcion,
                servicios,
                faq,
                horarios,
                escalarSiNoConfia,
                escalarPalabrasClave,
                escalarPorReintentos,
                empresaId, // 👈 asociar con empresa autenticada
            },
        })

        return res.status(201).json({ message: "Configuración guardada", config })
    } catch (error) {
        console.error("Error al guardar:", error)
        return res.status(500).json({ error: "Error interno del servidor" })
    }
}

//
// 👉 CONTROLADOR: Obtener configuraciones solo de la empresa autenticada
//
export async function getAllConfigs(req: Request, res: Response) {
    const empresaId = req.user?.empresaId

    try {
        const configs = await prisma.businessConfig.findMany({
            where: { empresaId }, // 👈 solo configs de esta empresa
            orderBy: { createdAt: "desc" },
        })

        return res.status(200).json(configs)
    } catch (error) {
        console.error("Error al obtener configuraciones:", error)
        return res.status(500).json({ error: "Error al obtener configuraciones" })
    }
}

//
// 👉 CONTROLADOR: Actualizar una configuración existente
//
export async function updateConfig(req: Request, res: Response) {
    const { id } = req.params
    const empresaId = req.user?.empresaId

    const {
        nombre,
        descripcion,
        servicios,
        faq,
        horarios,
        escalarSiNoConfia,
        escalarPalabrasClave,
        escalarPorReintentos
    } = req.body

    try {
        // Validar si pertenece a la empresa
        const existente = await prisma.businessConfig.findUnique({
            where: { id: Number(id) },
        })

        if (!existente || existente.empresaId !== empresaId) {
            return res.status(404).json({ error: "No autorizado para modificar esta configuración" })
        }

        const config = await prisma.businessConfig.update({
            where: { id: Number(id) },
            data: {
                nombre,
                descripcion,
                servicios,
                faq,
                horarios,
                escalarSiNoConfia,
                escalarPalabrasClave,
                escalarPorReintentos,
            },
        })

        return res.status(200).json({ message: "Configuración actualizada", config })
    } catch (error) {
        console.error("Error al actualizar configuración:", error)
        return res.status(500).json({ error: "No se pudo actualizar la configuración" })
    }
}

//
// 👉 CONTROLADOR: Eliminar una configuración
//
export async function deleteConfig(req: Request, res: Response) {
    const { id } = req.params
    const empresaId = req.user?.empresaId

    try {
        const existente = await prisma.businessConfig.findUnique({
            where: { id: Number(id) },
        })

        if (!existente || existente.empresaId !== empresaId) {
            return res.status(404).json({ error: "No autorizado para eliminar esta configuración" })
        }

        await prisma.businessConfig.delete({
            where: { id: Number(id) },
        })

        return res.status(200).json({ message: "Configuración eliminada" })
    } catch (error) {
        console.error("Error al eliminar configuración:", error)
        return res.status(500).json({ error: "No se pudo eliminar la configuración" })
    }
}

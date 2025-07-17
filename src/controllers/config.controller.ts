// src/controllers/config.controller.ts

import { Request, Response } from "express"
import prisma from '../lib/prisma'

//
// 👉 CONTROLADOR: Guardar configuración del negocio
//
// Ruta relacionada: POST /api/config
// Recibe: nombre, descripcion, servicios, faq, horarios
// Acción: guarda una nueva configuración en la tabla BusinessConfig
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
                escalarPorReintentos
            },
        })

        return res.status(201).json({ message: "Configuración guardada", config })
    } catch (error) {
        console.error("Error al guardar:", error)
        return res.status(500).json({ error: "Error interno del servidor" })
    }
}

//
// 👉 CONTROLADOR: Obtener todas las configuraciones guardadas
//
// Ruta relacionada: GET /api/config
// Acción: devuelve todos los registros de la tabla BusinessConfig ordenados por fecha (más recientes primero)
//
export async function getAllConfigs(req: Request, res: Response) {
    try {
        const configs = await prisma.businessConfig.findMany({
            orderBy: { createdAt: "desc" }, // Ordena de la más reciente a la más antigua
        })

        return res.status(200).json(configs)
    } catch (error) {
        console.error("Error al obtener configuraciones:", error)
        return res.status(500).json({ error: "Error al obtener configuraciones" })
    }
}
//
// 👉 CONTROLADOR: Actualizar una configuración existente por ID
// Ruta: PUT /api/config/:id
//
export async function updateConfig(req: Request, res: Response) {
    const { id } = req.params
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
                escalarPorReintentos
            },
        })

        return res.status(200).json({ message: "Configuración actualizada", config })
    } catch (error) {
        console.error("Error al actualizar configuración:", error)
        return res.status(500).json({ error: "No se pudo actualizar la configuración" })
    }
}


//
// 👉 CONTROLADOR: Eliminar una configuración por ID
// Ruta: DELETE /api/config/:id
//
export async function deleteConfig(req: Request, res: Response) {
    const { id } = req.params

    try {
        await prisma.businessConfig.delete({
            where: { id: Number(id) },
        })

        return res.status(200).json({ message: "Configuración eliminada" })
    } catch (error) {
        console.error("Error al eliminar configuración:", error)
        return res.status(500).json({ error: "No se pudo eliminar la configuración" })
    }
}

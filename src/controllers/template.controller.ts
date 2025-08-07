import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import axios from 'axios'

// ✅ Crear plantilla
export const crearPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        const { nombre, idioma, categoria, cuerpo } = req.body

        if (!nombre || !idioma || !categoria || !cuerpo) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' })
        }

        const matches = cuerpo.match(/{{\d+}}/g)
        const variables = matches ? matches.length : 0

        const plantilla = await prisma.messageTemplate.create({
            data: {
                nombre,
                idioma,
                categoria,
                cuerpo,
                variables,
                empresaId
            }
        })

        return res.status(201).json(plantilla)
    } catch (error) {
        console.error('❌ Error al crear plantilla:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Obtener todas las plantillas de una empresa
export const listarPlantillas = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        const plantillas = await prisma.messageTemplate.findMany({
            where: { empresaId },
            orderBy: { createdAt: 'desc' }
        })

        return res.json(plantillas)
    } catch (error) {
        console.error('❌ Error al listar plantillas:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Obtener una plantilla por ID
export const obtenerPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const id = Number(req.params.id)

        const plantilla = await prisma.messageTemplate.findFirst({
            where: { id, empresaId }
        })

        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        return res.json(plantilla)
    } catch (error) {
        console.error('❌ Error al obtener plantilla:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Eliminar una plantilla
export const eliminarPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const id = Number(req.params.id)

        const plantilla = await prisma.messageTemplate.findFirst({
            where: { id, empresaId }
        })

        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        await prisma.messageTemplate.delete({ where: { id } })

        return res.json({ mensaje: 'Plantilla eliminada correctamente' })
    } catch (error) {
        console.error('❌ Error al eliminar plantilla:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Enviar plantilla a Meta (con axios)
export const enviarPlantillaAMeta = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const plantillaId = Number(req.params.id)

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: { cuentaWhatsapp: true }
        })

        const plantilla = await prisma.messageTemplate.findFirst({
            where: { id: plantillaId, empresaId }
        })

        if (!empresa?.cuentaWhatsapp || !plantilla) {
            return res.status(404).json({ error: 'Empresa o plantilla no encontrada' })
        }

        const { wabaId, accessToken } = empresa.cuentaWhatsapp

        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
            {
                name: plantilla.nombre,
                language: { code: plantilla.idioma },
                category: plantilla.categoria,
                components: [
                    {
                        type: 'BODY',
                        text: plantilla.cuerpo
                    }
                ]
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        )

        const data = response.data

        await prisma.messageTemplate.update({
            where: { id: plantilla.id },
            data: { estado: 'enviado' }
        })

        return res.json({ mensaje: 'Plantilla enviada correctamente', data })
    } catch (error: any) {
        console.error('❌ Error al enviar plantilla a Meta:', error.response?.data || error)
        return res.status(400).json({
            error: 'Meta rechazó la plantilla',
            details: error.response?.data || error.message
        })
    }
}

// ✅ Consultar estado de plantilla en Meta (con axios)
export const consultarEstadoPlantilla = async (req: Request, res: Response) => {
    const empresaId = req.user?.empresaId
    const templateId = parseInt(req.params.id)

    if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

    try {
        const plantilla = await prisma.messageTemplate.findUnique({
            where: { id: templateId },
        })

        if (!plantilla || plantilla.empresaId !== empresaId)
            return res.status(404).json({ error: 'Plantilla no encontrada' })

        const cuenta = await prisma.whatsappAccount.findUnique({
            where: { empresaId },
        })

        if (!cuenta)
            return res.status(400).json({ error: 'Cuenta de WhatsApp no conectada' })

        const { accessToken, phoneNumberId } = cuenta

        const response = await axios.get(
            `https://graph.facebook.com/v19.0/${phoneNumberId}/message_templates`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        )

        const templates = response.data.data
        const actual = templates.find((t: any) => t.name === plantilla.nombre)

        if (!actual) return res.status(404).json({ error: 'Plantilla no encontrada en Meta' })

        await prisma.messageTemplate.update({
            where: { id: plantilla.id },
            data: { estado: actual.status || 'unknown' },
        })

        return res.json({ estado: actual.status })
    } catch (error) {
        console.error('❌ Error al consultar estado:', error)
        return res.status(500).json({ error: 'Error al consultar estado' })
    }
}

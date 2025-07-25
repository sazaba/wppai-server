import { Request, Response } from 'express'
import prisma from '../lib/prisma'

export const getEmpresa = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId

        if (!empresaId) {
            return res.status(401).json({ error: 'No autorizado' })
        }

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            select: { id: true, nombre: true }
        })

        if (!empresa) {
            return res.status(404).json({ error: 'Empresa no encontrada' })
        }

        return res.json(empresa)
    } catch (err) {
        console.error('❌ Error al obtener empresa:', err)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

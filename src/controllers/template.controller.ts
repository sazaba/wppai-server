// server/src/controllers/template.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import {
    listTemplatesFromMeta,
    createTemplateInMeta,
    deleteTemplateInMeta
} from '../services/template.service'
import { getWabaCredsByEmpresa } from '../services/waba-creds'

// ✅ Crear plantilla (DB) y opcionalmente publicar en Meta con ?publicar=true
export const crearPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        const { nombre, idioma, categoria, cuerpo } = req.body
        const publicar = String(req.query.publicar || 'false') === 'true'

        if (!nombre || !idioma || !categoria || !cuerpo) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' })
        }

        // Contar variables {{n}}
        const matches = cuerpo.match(/{{\d+}}/g)
        const variables = matches ? matches.length : 0

        // Upsert por (empresaId, nombre, idioma) — requiere @@unique([empresaId, nombre, idioma]) en Prisma
        const creada = await prisma.messageTemplate.upsert({
            where: { empresaId_nombre_idioma: { empresaId, nombre, idioma } },
            update: { categoria, cuerpo, variables },
            create: { nombre, idioma, categoria, cuerpo, variables, empresaId }
        })

        if (!publicar) {
            return res.status(201).json(creada)
        }

        // Publicar en Meta
        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId)
        const created = await createTemplateInMeta(wabaId, accessToken, {
            name: nombre,
            category: (categoria || '').toUpperCase() as any, // UTILITY | MARKETING | AUTHENTICATION
            language: idioma, // string simple: 'es', 'es_AR', 'en_US'
            bodyText: cuerpo
        })

        await prisma.messageTemplate.update({
            where: { empresaId_nombre_idioma: { empresaId, nombre, idioma } },
            data: { estado: 'enviado' }
        })

        return res.status(201).json({ ...creada, meta: created })
    } catch (error: any) {
        console.error('❌ Error al crear plantilla:', error?.response?.data || error)
        return res.status(500).json({ error: error?.response?.data || 'Error interno del servidor' })
    }
}

// ✅ Listar plantillas: lee Meta (con BODY), sincroniza DB y devuelve desde DB
export const listarPlantillas = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        // 1) trae plantillas desde Meta (incluye components → BODY)
        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId)
        const meta = await listTemplatesFromMeta(wabaId, accessToken)

        // 2) sincroniza DB (cuerpo y variables si están disponibles)
        for (const t of meta) {
            let bodyText = ''
            if (Array.isArray(t.components)) {
                const body = t.components.find((c: any) => c.type === 'BODY')
                if (body?.text) bodyText = body.text
            }
            const matches = bodyText ? bodyText.match(/{{\d+}}/g) : null
            const variables = matches ? matches.length : 0

            await prisma.messageTemplate.upsert({
                where: { empresaId_nombre_idioma: { empresaId, nombre: t.name, idioma: t.language } },
                update: {
                    categoria: t.category,
                    estado: t.status,
                    ...(bodyText ? { cuerpo: bodyText, variables } : {})
                },
                create: {
                    empresaId,
                    nombre: t.name,
                    idioma: t.language,
                    categoria: t.category,
                    estado: t.status,
                    cuerpo: bodyText || '',
                    variables
                }
            })
        }

        // 3) devuelve desde DB
        const plantillas = await prisma.messageTemplate.findMany({
            where: { empresaId },
            orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }]
        })

        return res.json(plantillas)
    } catch (error) {
        console.error('❌ Error al listar plantillas:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Obtener una plantilla por ID (DB)
export const obtenerPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const id = Number(req.params.id)
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' })

        const plantilla = await prisma.messageTemplate.findFirst({ where: { id, empresaId } })
        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        return res.json(plantilla)
    } catch (error) {
        console.error('❌ Error al obtener plantilla:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Eliminar plantilla (DB) y opcionalmente en Meta con ?borrarMeta=true
export const eliminarPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const id = Number(req.params.id)
        const borrarMeta = String(req.query.borrarMeta || 'true') === 'true'
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' })

        const plantilla = await prisma.messageTemplate.findFirst({ where: { id, empresaId } })
        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        if (borrarMeta) {
            try {
                const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId!)
                await deleteTemplateInMeta(wabaId, accessToken, plantilla.nombre, plantilla.idioma)
            } catch (e: any) {
                console.warn('[eliminarPlantilla] No se pudo borrar en Meta:', e?.response?.data || e?.message)
            }
        }

        await prisma.messageTemplate.delete({ where: { id } })
        return res.json({ mensaje: 'Plantilla eliminada correctamente' })
    } catch (error) {
        console.error('❌ Error al eliminar plantilla:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ✅ Publicar en Meta una plantilla existente (por ID)
export const enviarPlantillaAMeta = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const plantillaId = Number(req.params.id)
        if (!Number.isInteger(plantillaId)) return res.status(400).json({ error: 'ID inválido' })

        const plantilla = await prisma.messageTemplate.findFirst({ where: { id: plantillaId, empresaId } })
        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId!)
        const created = await createTemplateInMeta(wabaId, accessToken, {
            name: plantilla.nombre,
            category: (plantilla.categoria || '').toUpperCase() as any,
            language: plantilla.idioma,
            bodyText: plantilla.cuerpo
        })

        await prisma.messageTemplate.update({
            where: { id: plantilla.id },
            data: { estado: 'enviado' }
        })

        return res.json({ mensaje: 'Plantilla enviada correctamente', data: created })
    } catch (error: any) {
        console.error('❌ Error al enviar plantilla a Meta:', error.response?.data || error)
        return res.status(400).json({
            error: 'Meta rechazó la plantilla',
            details: error.response?.data || error.message
        })
    }
}

// ✅ Consultar estado de una plantilla en Meta (por nombre+idioma) y actualizar DB
export const consultarEstadoPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const templateId = Number(req.params.id)
        if (!empresaId) return res.status(401).json({ error: 'No autorizado' })
        if (!Number.isInteger(templateId)) return res.status(400).json({ error: 'ID inválido' })

        const plantilla = await prisma.messageTemplate.findFirst({ where: { id: templateId, empresaId } })
        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId)
        const meta = await listTemplatesFromMeta(wabaId, accessToken)

        const actual = meta.find((t: any) => t.name === plantilla.nombre && t.language === plantilla.idioma)
        if (!actual) {
            return res.status(404).json({ error: 'Plantilla no encontrada en Meta' })
        }

        await prisma.messageTemplate.update({
            where: { id: plantilla.id },
            data: { estado: actual.status || 'unknown' }
        })

        return res.json({ estado: actual.status })
    } catch (error) {
        console.error('❌ Error al consultar estado:', error)
        return res.status(500).json({ error: 'Error al consultar estado' })
    }
}

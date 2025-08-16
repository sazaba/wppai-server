// server/src/controllers/template.controller.ts
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import {
    listTemplatesFromMeta,
    createTemplateInMeta,
    deleteTemplateInMeta
} from '../services/template.service'
import { getWabaCredsByEmpresa } from '../services/waba-creds'

// ───────────────────────────────────────────────────────────────────────────────
// Helper: evita publicar si ya existe name+language en Meta (lanza 409)
// ───────────────────────────────────────────────────────────────────────────────
async function ensureTemplateDoesNotExistInMeta(params: {
    wabaId: string
    accessToken: string
    name: string
    language: string
}) {
    const meta = await listTemplatesFromMeta(params.wabaId, params.accessToken)
    const exists = meta.some(t => t.name === params.name && t.language === params.language)
    if (exists) {
        const err: any = new Error('Ya existe una plantilla con ese nombre e idioma en Meta.')
        err.status = 409
        err.code = 'DUPLICATE_META_TEMPLATE'
        throw err
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// Crear plantilla (DB) y opcionalmente publicar en Meta con ?publicar=true
// ───────────────────────────────────────────────────────────────────────────────
export const crearPlantilla = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        const { nombre, idioma, categoria, cuerpo } = req.body
        const publicar = String(req.query.publicar || 'false') === 'true'

        if (!nombre || !idioma || !categoria || !cuerpo) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' })
        }

        const matches = cuerpo.match(/{{\d+}}/g)
        const variables = matches ? matches.length : 0

        const creada = await prisma.messageTemplate.upsert({
            where: { empresaId_nombre_idioma: { empresaId, nombre, idioma } },
            update: { categoria, cuerpo, variables },
            create: { nombre, idioma, categoria, cuerpo, variables, empresaId }
        })

        if (!publicar) {
            return res.status(201).json(creada)
        }

        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId)

        // ⚠️ evita error "Content in This Language Already Exists"
        await ensureTemplateDoesNotExistInMeta({ wabaId, accessToken, name: nombre, language: idioma })

        const created = await createTemplateInMeta(wabaId, accessToken, {
            name: nombre,
            category: (categoria || '').toUpperCase(),
            language: idioma,
            bodyText: cuerpo
        })

        await prisma.messageTemplate.update({
            where: { empresaId_nombre_idioma: { empresaId, nombre, idioma } },
            data: { estado: 'enviado' }
        })

        return res.status(201).json({ ...creada, meta: created })
    } catch (error: any) {
        const metaMsg = error?.response?.data?.error?.error_user_msg
        if (error?.status === 409 || error?.code === 'DUPLICATE_META_TEMPLATE') {
            return res.status(409).json({ error: 'Ya existe una plantilla con ese nombre e idioma en Meta. Usa otro nombre o idioma.' })
        }
        if (metaMsg) return res.status(400).json({ error: metaMsg })
        console.error('❌ Error al crear plantilla:', error?.response?.data || error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// Listar: lee Meta (incluye BODY), sincroniza DB y devuelve desde DB
// ───────────────────────────────────────────────────────────────────────────────
export const listarPlantillas = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        if (!empresaId) return res.status(401).json({ error: 'Unauthorized' })

        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId)
        const meta = await listTemplatesFromMeta(wabaId, accessToken)

        console.log('[templates] Meta →', meta.map(t => ({ name: t.name, language: t.language, status: t.status, cat: t.category })))

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

        const plantillas = await prisma.messageTemplate.findMany({
            where: { empresaId },
            orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }]
        })

        console.log('[templates] DB →', plantillas.map(p => ({ id: p.id, nombre: p.nombre, idioma: p.idioma, estado: p.estado })))

        return res.json(plantillas)
    } catch (error) {
        console.error('❌ Error al listar plantillas:', error)
        return res.status(500).json({ error: 'Error interno del servidor' })
    }
}

// ───────────────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────────────────────
export const enviarPlantillaAMeta = async (req: Request, res: Response) => {
    try {
        const empresaId = req.user?.empresaId
        const plantillaId = Number(req.params.id)
        if (!Number.isInteger(plantillaId)) return res.status(400).json({ error: 'ID inválido' })

        const plantilla = await prisma.messageTemplate.findFirst({ where: { id: plantillaId, empresaId } })
        if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' })

        const { accessToken, wabaId } = await getWabaCredsByEmpresa(empresaId!)

        // ⚠️ evita duplicados en Meta
        await ensureTemplateDoesNotExistInMeta({ wabaId, accessToken, name: plantilla.nombre, language: plantilla.idioma })

        const created = await createTemplateInMeta(wabaId, accessToken, {
            name: plantilla.nombre,
            category: (plantilla.categoria || '').toUpperCase(),
            language: plantilla.idioma,
            bodyText: plantilla.cuerpo
        })

        await prisma.messageTemplate.update({
            where: { id: plantilla.id },
            data: { estado: 'enviado' }
        })

        return res.json({ mensaje: 'Plantilla enviada correctamente', data: created })
    } catch (error: any) {
        if (error?.status === 409 || error?.code === 'DUPLICATE_META_TEMPLATE') {
            return res.status(409).json({ error: 'Ya existe una plantilla con ese nombre e idioma en Meta. Usa otro nombre o idioma.' })
        }
        const metaMsg = error?.response?.data?.error?.error_user_msg
        if (metaMsg) return res.status(400).json({ error: metaMsg })
        console.error('❌ Error al enviar plantilla a Meta:', error?.response?.data || error)
        return res.status(400).json({ error: 'Meta rechazó la plantilla' })
    }
}

// ───────────────────────────────────────────────────────────────────────────────
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

        const actual = meta.find(t => t.name === plantilla.nombre && t.language === plantilla.idioma)
        if (!actual) return res.status(404).json({ error: 'Plantilla no encontrada en Meta' })

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

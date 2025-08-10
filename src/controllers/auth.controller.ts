import axios from 'axios'
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import bcrypt from 'bcrypt'
import { generarToken } from '../utils/jwt'
import jwt, { JwtPayload as DefaultJwtPayload } from 'jsonwebtoken'

interface CustomJwtPayload extends DefaultJwtPayload {
    empresaId: number
}

const GRAPH = 'https://graph.facebook.com/v20.0'

// ==========================
// AUTH APLICACIÓN (LOGIN/REGISTER)
// ==========================

// ✅ Login con empresa activa
export const login = async (req: Request, res: Response) => {
    console.log('🟡 [LOGIN] Body recibido:', req.body)

    const { email, password } = req.body
    if (!email || !password) {
        console.warn('⚠️ [LOGIN] Faltan email o password')
        return res.status(400).json({ error: 'Email y contraseña requeridos' })
    }

    try {
        const usuario = await prisma.usuario.findUnique({
            where: { email },
            include: { empresa: true }
        })

        if (!usuario) {
            console.warn('❌ [LOGIN] Usuario no encontrado:', email)
            return res.status(404).json({ error: 'Usuario no encontrado' })
        }

        console.log('✅ [LOGIN] Usuario encontrado:', usuario.email)

        const valido = await bcrypt.compare(password, usuario.password)
        if (!valido) {
            console.warn('❌ [LOGIN] Contraseña incorrecta')
            return res.status(401).json({ error: 'Contraseña incorrecta' })
        }

        if (!usuario.empresa || usuario.empresa.estado !== 'activo') {
            console.warn('❌ [LOGIN] Empresa inactiva o no encontrada')
            return res.status(403).json({ error: 'La empresa aún no está activa. Debes completar el pago.' })
        }

        console.log('✅ [LOGIN] Empresa activa:', usuario.empresa.nombre)

        const token = generarToken({
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresaId: usuario.empresaId
        })

        console.log('✅ [LOGIN] Token generado correctamente')
        return res.json({ token, empresaId: usuario.empresaId })
    } catch (error) {
        console.error('🔥 [LOGIN] Error inesperado:', error)
        return res.status(500).json({ error: 'Error en el login' })
    }
}

// ✅ Registro: crea empresa + usuario admin con prueba gratuita
export const registrar = async (req: Request, res: Response) => {
    const { nombreEmpresa, email, password } = req.body
    if (!nombreEmpresa || !email || !password) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' })
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10)

        const ahora = new Date()
        const finPrueba = new Date()
        finPrueba.setDate(ahora.getDate() + 30) // +30 días

        const empresa = await prisma.empresa.create({
            data: {
                nombre: nombreEmpresa,
                estado: 'activo',
                plan: 'gratis',
                trialStart: ahora,
                trialEnd: finPrueba,
                conversationsUsed: 0,
                usuarios: {
                    create: {
                        email,
                        password: hashedPassword,
                        rol: 'admin'
                    }
                }
            },
            include: { usuarios: true }
        })

        const usuario = empresa.usuarios[0]
        const token = generarToken({
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresaId: empresa.id
        })

        return res.status(201).json({ token, empresaId: empresa.id })
    } catch (error) {
        console.error('[registrar] Error:', error)
        return res.status(500).json({ error: 'Error al registrar empresa' })
    }
}

// ==========================
// OAUTH META
// ==========================

interface MetaTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
}

// 1) Intercambia code -> user access token y redirige al front con ?token=
export const authCallback = async (req: Request, res: Response) => {
    const { code } = req.query
    if (!code) return res.status(400).json({ error: 'Falta el parámetro code' })

    try {
        const tokenRes = await axios.get<MetaTokenResponse>(`${GRAPH}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI,
                code
            }
        })

        const accessToken = tokenRes.data.access_token
        // Redirige al CallbackPage del front con el token (temporal del usuario)
        return res.redirect(`${process.env.FRONT_CALLBACK_URL || 'https://wasaaa.com/dashboard/callback'}?token=${accessToken}`)
    } catch (err: any) {
        console.error('[authCallback] Error Meta:', err.response?.data || err.message)
        return res.status(500).json({ error: '❌ Error autenticando con Meta.' })
    }
}

// (opcional si lo usas desde el front)
export const exchangeCode = async (req: Request, res: Response) => {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: 'Missing code' })

    try {
        const r = await axios.get(`${GRAPH}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI,
                code
            }
        })
        return res.json({ access_token: r.data.access_token })
    } catch (e: any) {
        console.error('[exchangeCode] Meta error:', e.response?.data || e.message)
        return res.status(400).json({ error: e.response?.data || e.message })
    }
}

// ==========================
// LISTAR WABAS + PHONES (con fallback y mensajes claros)
// ==========================


type Waba = { id: string; name?: string }
type Phone = { id: string; display_phone_number?: string }
type WabaWithPhones = { waba: Waba; phones: Phone[] }

async function getAssignedWabas(userToken: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/me/assigned_whatsapp_business_accounts`
    const { data } = await axios.get(url, { params: { fields: 'id,name', access_token: userToken } })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'assigned_whatsapp_business_accounts' }
}

async function getOwnedWabas(userToken: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/me/owned_whatsapp_business_accounts`
    const { data } = await axios.get(url, { params: { fields: 'id,name', access_token: userToken } })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'owned_whatsapp_business_accounts' }
}

async function getBusinesses(userToken: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/me/businesses`
    const { data } = await axios.get(url, { params: { fields: 'id,name', access_token: userToken } })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'me.businesses' }
}

async function getWabasByBusiness(userToken: string, businessId: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/${businessId}/owned_whatsapp_business_accounts`
    const { data } = await axios.get(url, { params: { fields: 'id,name', access_token: userToken } })
    return { list: data?.data || [], ms: Date.now() - t0, stage: `business.${businessId}.owned_wabas` }
}

async function getPhonesForWaba(userToken: string, wabaId: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/${wabaId}/phone_numbers`
    const { data } = await axios.get(url, { params: { fields: 'id,display_phone_number', access_token: userToken } })
    return { list: data?.data || [], ms: Date.now() - t0, stage: `waba.${wabaId}.phones` }
}

async function getPermissions(userToken: string) {
    const t0 = Date.now()
    const url = `${GRAPH}/me/permissions`
    const { data } = await axios.get(url, { params: { access_token: userToken } })
    const list: Array<{ permission: string; status: string }> = data?.data || []
    const need = ['whatsapp_business_management', 'whatsapp_business_messaging']
    const missing = need.filter(p => !list.some(x => x.permission === p && x.status === 'granted'))
    return { all: list, missing, ms: Date.now() - t0, stage: 'me.permissions' }
}

function metaErrorPayload(e: any) {
    const err = e?.response?.data?.error
    return err
        ? {
            code: err.code,
            type: err.type,
            message: err.message,
            fbtrace_id: err.fbtrace_id,
        }
        : { message: e?.message || 'Unknown error' }
}

export const getWabasAndPhones = async (req: Request, res: Response) => {
    const token = (req.query.token as string) || (req.body?.token as string)
    const debug = req.query.debug === '1'
    if (!token) return res.status(400).json({ error: 'Missing user access token' })

    const diagnostics: any = { tried: [], timings: {} }

    try {
        // 0) Permisos (para saber qué falta)
        try {
            const perms = await getPermissions(token)
            diagnostics.permissions = perms
            diagnostics.timings[perms.stage] = perms.ms
            if (perms.missing.length && debug) {
                console.warn('[getWabasAndPhones] Missing permissions:', perms.missing)
            }
        } catch (e: any) {
            const meta = metaErrorPayload(e)
            diagnostics.permissions_error = meta
            console.warn('[getWabasAndPhones] me/permissions error:', meta)
            // seguimos; no detenemos aún
        }

        let wabas: Waba[] = []

        // 1) ASSIGNED
        try {
            const r1 = await getAssignedWabas(token)
            diagnostics.tried.push(r1.stage)
            diagnostics.timings[r1.stage] = r1.ms
            wabas = r1.list
            console.log(`[getWabasAndPhones] assigned → ${wabas.length} WABAs (${r1.ms}ms)`)
        } catch (e: any) {
            const meta = metaErrorPayload(e)
            diagnostics.assigned_error = meta
            console.warn('[getWabasAndPhones] assigned error:', meta)
            // continuar
        }

        // 2) OWNED (si vacío)
        if (!wabas?.length) {
            try {
                const r2 = await getOwnedWabas(token)
                diagnostics.tried.push(r2.stage)
                diagnostics.timings[r2.stage] = r2.ms
                wabas = r2.list
                console.log(`[getWabasAndPhones] owned → ${wabas.length} WABAs (${r2.ms}ms)`)
            } catch (e: any) {
                const meta = metaErrorPayload(e)
                diagnostics.owned_error = meta
                console.warn('[getWabasAndPhones] owned error:', meta)
                // continuar
            }
        }

        // 3) Businesses → owned_wabas (si sigue vacío)
        if (!wabas?.length) {
            try {
                const r3 = await getBusinesses(token)
                diagnostics.tried.push(r3.stage)
                diagnostics.timings[r3.stage] = r3.ms
                console.log(`[getWabasAndPhones] businesses → ${r3.list.length} (${r3.ms}ms)`)

                for (const b of r3.list) {
                    try {
                        const r4 = await getWabasByBusiness(token, b.id)
                        diagnostics.tried.push(r4.stage)
                        diagnostics.timings[r4.stage] = r4.ms
                        console.log(`[getWabasAndPhones] business ${b.id} owned_wabas → ${r4.list.length} (${r4.ms}ms)`)
                        wabas = [...wabas, ...r4.list]
                    } catch (e: any) {
                        const meta = metaErrorPayload(e)
                        diagnostics[`business_${b.id}_error`] = meta
                        console.warn(`[getWabasAndPhones] owned_wabas by business ${b.id} error:`, meta)
                    }
                }
            } catch (e: any) {
                const meta = metaErrorPayload(e)
                diagnostics.businesses_error = meta
                console.warn('[getWabasAndPhones] businesses error:', meta)

                if (meta.code === 3) {
                    return res.status(403).json({
                        errorCode: 3,
                        message:
                            'Tu usuario no tiene permisos suficientes en el Business que posee la WABA. ' +
                            'Asigna el asset “Cuentas de WhatsApp” (control total) o usa Embedded Signup.',
                        meta: debug ? meta : undefined,
                        diagnostics: debug ? diagnostics : undefined,
                    })
                }
            }
        }

        // 4) Si sigue vacío, devolver info clara
        if (!wabas?.length) {
            return res.status(200).json({
                items: [],
                note:
                    'No se encontraron WABAs para este usuario. Verifica que el usuario pertenezca al Business ' +
                    'y tenga asignado el asset “Cuentas de WhatsApp”.',
                diagnostics: debug ? diagnostics : undefined,
            })
        }

        // 5) Phones por cada WABA
        const items: WabaWithPhones[] = []
        for (const w of wabas) {
            try {
                const r5 = await getPhonesForWaba(token, w.id)
                diagnostics.timings[r5.stage] = r5.ms
                items.push({ waba: w, phones: r5.list })
            } catch (e: any) {
                const meta = metaErrorPayload(e)
                diagnostics[`waba_${w.id}_phones_error`] = meta
                console.warn(`[getWabasAndPhones] phones for waba ${w.id} error:`, meta)
                items.push({ waba: w, phones: [] })
            }
        }

        return res.json({
            items,
            diagnostics: debug ? diagnostics : undefined,
        })
    } catch (e: any) {
        const meta = metaErrorPayload(e)
        console.error('[getWabasAndPhones] Fatal error:', meta)

        if (meta.code === 3) {
            return res.status(403).json({
                errorCode: 3,
                message:
                    'Este edge sólo está disponible para business user o system user. ' +
                    'Asegura permisos completos en la WABA o usa Embedded Signup.',
                meta: debug ? meta : undefined,
                diagnostics: debug ? diagnostics : undefined,
            })
        }

        return res.status(500).json({
            error: 'Error listando WABAs y teléfonos',
            meta: debug ? meta : undefined,
            diagnostics: debug ? diagnostics : undefined,
        })
    }
}

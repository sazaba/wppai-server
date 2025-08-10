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
        return res.redirect(
            `${process.env.FRONT_CALLBACK_URL || 'https://wasaaa.com/dashboard/callback'}?token=${accessToken}`
        )
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
// LISTAR WABAS + PHONES (vía Business) + fallback
// ==========================

type Waba = { id: string; name?: string; owner_business_id?: string }
type Phone = { id: string; display_phone_number?: string }
type WabaWithPhones = { waba: Waba; phones: Phone[] }

// Helpers HTTP
async function fbGet(url: string, params: Record<string, any>) {
    const { data } = await axios.get(url, { params })
    return data
}

// Edges
async function getBusinesses(userToken: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/me/businesses`, { fields: 'id,name', access_token: userToken })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'me.businesses' }
}

async function getWabasByBusiness(userToken: string, businessId: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/${businessId}/owned_whatsapp_business_accounts`, {
        fields: 'id,name',
        access_token: userToken
    })
    // Enriquecer con owner_business_id = businessId
    const list: Waba[] = (data?.data || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        owner_business_id: businessId
    }))
    return { list, ms: Date.now() - t0, stage: `business.${businessId}.owned_wabas` }
}

async function getPhonesForWaba(userToken: string, wabaId: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/${wabaId}/phone_numbers`, {
        fields: 'id,display_phone_number',
        access_token: userToken
    })
    return { list: data?.data || [], ms: Date.now() - t0, stage: `waba.${wabaId}.phones` }
}

async function getPermissions(userToken: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/me/permissions`, { access_token: userToken })
    const list: Array<{ permission: string; status: string }> = data?.data || []
    const need = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging']
    const missing = need.filter(p => !list.some(x => x.permission === p && x.status === 'granted'))
    return { all: list, missing, ms: Date.now() - t0, stage: 'me.permissions' }
}

// (opcionales — fallbacks best-effort; pueden fallar con (#3) / (#100))
async function getAssignedWabas(userToken: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/me/assigned_whatsapp_business_accounts`, {
        fields: 'id,name',
        access_token: userToken
    })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'me.assigned_wabas' }
}
async function getOwnedWabasAtUser(userToken: string) {
    const t0 = Date.now()
    const data = await fbGet(`${GRAPH}/me/owned_whatsapp_business_accounts`, {
        fields: 'id,name',
        access_token: userToken
    })
    return { list: data?.data || [], ms: Date.now() - t0, stage: 'me.owned_wabas' }
}

function metaErrorPayload(e: any) {
    const err = e?.response?.data?.error
    return err
        ? { code: err.code, type: err.type, message: err.message, fbtrace_id: err.fbtrace_id }
        : { message: e?.message || 'Unknown error' }
}

export const getWabasAndPhones = async (req: Request, res: Response) => {
    const token = (req.query.token as string) || (req.body?.token as string)
    const debug = req.query.debug === '1'
    if (!token) return res.status(400).json({ error: 'Missing user access token' })

    const diagnostics: any = { tried: [], timings: {} }

    try {
        // 0) Permisos
        try {
            const perms = await getPermissions(token)
            diagnostics.permissions = perms
            diagnostics.timings[perms.stage] = perms.ms
            if (perms.missing.length) {
                // No cortamos de inmediato para devolver diagnóstico completo si debug=1
                if (!debug) {
                    return res.status(403).json({
                        errorCode: 200,
                        message: `Missing permissions: ${perms.missing.join(', ')}`,
                    })
                }
            }
        } catch (e: any) {
            const meta = metaErrorPayload(e)
            diagnostics.permissions_error = meta
            console.warn('[getWabasAndPhones] me/permissions error:', meta)
            // seguimos; no detenemos aún
        }

        // 1) Camino oficial: /me/businesses → /{business}/owned_whatsapp_business_accounts
        let wabas: Waba[] = []
        try {
            const b = await getBusinesses(token)
            diagnostics.tried.push(b.stage)
            diagnostics.timings[b.stage] = b.ms
            console.log(`[getWabasAndPhones] businesses → ${b.list.length} (${b.ms}ms)`)

            for (const biz of b.list) {
                try {
                    const ow = await getWabasByBusiness(token, biz.id)
                    diagnostics.tried.push(ow.stage)
                    diagnostics.timings[ow.stage] = ow.ms
                    console.log(
                        `[getWabasAndPhones] business ${biz.id} owned_wabas → ${ow.list.length} (${ow.ms}ms)`
                    )
                    wabas = [...wabas, ...ow.list]
                } catch (e: any) {
                    const meta = metaErrorPayload(e)
                    diagnostics[`business_${biz.id}_owned_wabas_error`] = meta
                    console.warn(`[getWabasAndPhones] owned_wabas by business ${biz.id} error:`, meta)
                }
            }
        } catch (e: any) {
            const meta = metaErrorPayload(e)
            diagnostics.businesses_error = meta
            console.warn('[getWabasAndPhones] businesses error:', meta)
        }

        // 2) Fallback best-effort: /me/assigned_* y /me/owned_* (pueden fallar)
        if (!wabas?.length) {
            try {
                const r1 = await getAssignedWabas(token)
                diagnostics.tried.push(r1.stage)
                diagnostics.timings[r1.stage] = r1.ms
                wabas = [...wabas, ...r1.list]
                console.log(`[getWabasAndPhones] assigned → ${r1.list.length} WABAs (${r1.ms}ms)`)
            } catch (e: any) {
                diagnostics.assigned_error = metaErrorPayload(e)
                console.warn('[getWabasAndPhones] assigned error:', diagnostics.assigned_error)
            }

            try {
                const r2 = await getOwnedWabasAtUser(token)
                diagnostics.tried.push(r2.stage)
                diagnostics.timings[r2.stage] = r2.ms
                wabas = [...wabas, ...r2.list]
                console.log(`[getWabasAndPhones] owned(user) → ${r2.list.length} WABAs (${r2.ms}ms)`)
            } catch (e: any) {
                diagnostics.owned_user_error = metaErrorPayload(e)
                console.warn('[getWabasAndPhones] owned(user) error:', diagnostics.owned_user_error)
            }
        }

        // 3) Si sigue vacío, devolver info clara
        if (!wabas?.length) {
            return res.status(200).json({
                items: [],
                note:
                    'No se encontraron WABAs para este usuario. Verifica que el usuario sea Admin del Business ' +
                    'y tenga asignado el asset “Cuentas de WhatsApp”. Si la app está en Dev Mode, agrega el usuario como tester.',
                diagnostics: debug ? diagnostics : undefined
            })
        }

        // 4) Phones por cada WABA
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
            diagnostics: debug ? diagnostics : undefined
        })
    } catch (e: any) {
        const meta = metaErrorPayload(e)
        console.error('[getWabasAndPhones] Fatal error:', meta)

        // Mensajes más claros
        if (meta.code === 3) {
            return res.status(403).json({
                errorCode: 3,
                message:
                    'Este edge solo está disponible para business user o system user. ' +
                    'Usa el camino /me/businesses o Embedded Signup, o genera un System User token.',
                meta: debug ? meta : undefined,
                diagnostics: debug ? diagnostics : undefined
            })
        }
        if (meta.code === 200) {
            return res.status(403).json({
                errorCode: 200,
                message:
                    'Requiere business_management para gestionar el objeto Business. ' +
                    'Asegura que el usuario re-autorice con ese scope y sea Admin del Business.',
                meta: debug ? meta : undefined,
                diagnostics: debug ? diagnostics : undefined
            })
        }

        return res.status(500).json({
            error: 'Error listando WABAs y teléfonos',
            meta: debug ? meta : undefined,
            diagnostics: debug ? diagnostics : undefined
        })
    }
}
// PÚBLICO: inicia el flujo OAuth → redirige a Meta
export const iniciarOAuthMeta = (req: Request, res: Response) => {
    const APP_ID = process.env.META_APP_ID!
    const REDIRECT = process.env.META_REDIRECT_URI! // debe apuntar a TU callback de backend
    const version = 'v20.0'

    const auth_type = (req.query.auth_type as string) || '' // ej: rerequest
    const scope = [
        'business_management',
        'whatsapp_business_management',
        'whatsapp_business_messaging',
    ].join(',')

    const state = encodeURIComponent(JSON.stringify({ ts: Date.now() })) // opcional

    const url =
        `https://www.facebook.com/${version}/dialog/oauth` +
        `?client_id=${APP_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +   // 👈 callback de BACKEND
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}` +
        (auth_type ? `&auth_type=${encodeURIComponent(auth_type)}` : '') +
        `&state=${state}`

    return res.redirect(url)
}

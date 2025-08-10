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
    const url = `${GRAPH}/me/assigned_whatsapp_business_accounts`
    const { data } = await axios.get(url, {
        params: { fields: 'id,name', access_token: userToken }
    })
    return data?.data || []
}

async function getOwnedWabas(userToken: string) {
    const url = `${GRAPH}/me/owned_whatsapp_business_accounts`
    const { data } = await axios.get(url, {
        params: { fields: 'id,name', access_token: userToken }
    })
    return data?.data || []
}

async function getBusinesses(userToken: string) {
    const url = `${GRAPH}/me/businesses`
    const { data } = await axios.get(url, {
        params: { fields: 'id,name', access_token: userToken }
    })
    return data?.data || []
}

async function getWabasByBusiness(userToken: string, businessId: string) {
    const url = `${GRAPH}/${businessId}/owned_whatsapp_business_accounts`
    const { data } = await axios.get(url, {
        params: { fields: 'id,name', access_token: userToken }
    })
    return data?.data || []
}

async function getPhonesForWaba(userToken: string, wabaId: string) {
    const url = `${GRAPH}/${wabaId}/phone_numbers`
    const { data } = await axios.get(url, {
        params: { fields: 'id,display_phone_number', access_token: userToken }
    })
    return data?.data || []
}

/**
 * GET /api/auth/wabas
 * Frontend le pasa ?token=<user_access_token> (o en body.token)
 * Devuelve: { items: Array<{ waba:{id,name}, phones:[{id,display_phone_number}] }> }
 * En caso de error de permisos (#3), devuelve 403 con { errorCode: 3, message: ... }
 */
export const getWabasAndPhones = async (req: Request, res: Response) => {
    const token = (req.query.token as string) || (req.body?.token as string)
    if (!token) return res.status(400).json({ error: 'Missing user access token' })

    try {
        let wabas: Waba[] = []

        // 1) Intento: ASSIGNED
        try {
            wabas = await getAssignedWabas(token)
        } catch (e: any) {
            const code = e?.response?.data?.error?.code
            if (code === 3) {
                // seguimos con los siguientes intentos; también lo reportamos al final si todo falla
            } else {
                throw e
            }
        }

        // 2) Si no hay, intento OWNED
        if (!wabas?.length) {
            try {
                wabas = await getOwnedWabas(token)
            } catch (e: any) {
                const code = e?.response?.data?.error?.code
                if (code !== 3) throw e
            }
        }

        // 3) Si aún vacío, voy por businesses → owned_wabas por business
        if (!wabas?.length) {
            try {
                const businesses = await getBusinesses(token)
                for (const b of businesses) {
                    const owned = await getWabasByBusiness(token, b.id)
                    wabas = [...wabas, ...owned]
                }
            } catch (e: any) {
                const code = e?.response?.data?.error?.code
                if (code === 3) {
                    return res.status(403).json({
                        errorCode: 3,
                        message:
                            'Tu usuario no tiene permisos suficientes en el Business que posee la WABA. ' +
                            'Añádete como persona con acceso a “Cuentas de WhatsApp” (control total) o usa Embedded Signup.'
                    })
                }
                throw e
            }
        }

        // Si sigue vacío, informar claramente
        if (!wabas?.length) {
            return res.status(200).json({
                items: [],
                note:
                    'No se encontraron WABAs para este usuario. ' +
                    'Verifica que el usuario pertenezca al Business y tenga asset “Cuentas de WhatsApp” asignado.'
            })
        }

        // Phones por cada WABA
        const items: WabaWithPhones[] = []
        for (const w of wabas) {
            const phones = await getPhonesForWaba(token, w.id)
            items.push({ waba: w, phones })
        }

        return res.json({ items })
    } catch (e: any) {
        const metaErr = e?.response?.data?.error
        if (metaErr?.code === 3) {
            return res.status(403).json({
                errorCode: 3,
                message:
                    'Este edge sólo está disponible para business user o system user. ' +
                    'Asegura permisos completos en la WABA o usa Embedded Signup.'
            })
        }
        console.error('[getWabasAndPhones] Error:', e?.response?.data || e.message)
        return res.status(500).json({ error: 'Error listando WABAs y teléfonos' })
    }
}

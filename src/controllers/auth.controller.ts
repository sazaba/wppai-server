// src/controllers/auth.controller.ts
import axios from 'axios'
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import bcrypt from 'bcrypt'
import { generarToken } from '../utils/jwt'

const GRAPH = 'https://graph.facebook.com/v20.0'

/* =============================================================================
 * AUTH APP (LOGIN / REGISTER)
 * ========================================================================== */

export const login = async (req: Request, res: Response) => {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' })

    try {
        const usuario = await prisma.usuario.findUnique({
            where: { email },
            include: { empresa: true },
        })
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' })

        const ok = await bcrypt.compare(password, usuario.password)
        if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' })

        if (!usuario.empresa || usuario.empresa.estado !== 'activo') {
            return res.status(403).json({ error: 'La empresa aún no está activa. Debes completar el pago.' })
        }

        const token = generarToken({
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresaId: usuario.empresaId,
        })

        return res.json({ token, empresaId: usuario.empresaId })
    } catch (e) {
        console.error('[login] Error:', e)
        return res.status(500).json({ error: 'Error en el login' })
    }
}

export const registrar = async (req: Request, res: Response) => {
    const { nombreEmpresa, email, password } = req.body
    if (!nombreEmpresa || !email || !password) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' })
    }

    try {
        const hashed = await bcrypt.hash(password, 10)
        const ahora = new Date()
        const finPrueba = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000)

        const empresa = await prisma.empresa.create({
            data: {
                nombre: nombreEmpresa,
                estado: 'activo',
                plan: 'gratis',
                trialStart: ahora,
                trialEnd: finPrueba,
                conversationsUsed: 0,
                usuarios: {
                    create: { email, password: hashed, rol: 'admin' },
                },
            },
            include: { usuarios: true },
        })

        const u = empresa.usuarios[0]
        const token = generarToken({
            id: u.id,
            email: u.email,
            rol: u.rol,
            empresaId: empresa.id,
        })

        return res.status(201).json({ token, empresaId: empresa.id })
    } catch (e) {
        console.error('[registrar] Error:', e)
        return res.status(500).json({ error: 'Error al registrar empresa' })
    }
}

/* =============================================================================
 * OAUTH META (FLUJO ÚNICO)
 * ========================================================================== */

interface MetaTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
}

// GET /api/auth/whatsapp  → Redirige al diálogo OAuth
export const iniciarOAuthMeta = (req: Request, res: Response) => {
    const APP_ID = process.env.META_APP_ID!
    const REDIRECT = process.env.META_REDIRECT_URI! // Callback de BACKEND registrado en Meta
    const version = 'v20.0'

    const auth_type = (req.query.auth_type as string) || '' // p.ej. rerequest
    const scope = [
        'business_management',
        'whatsapp_business_management',
        'whatsapp_business_messaging',
    ].join(',')

    const url =
        `https://www.facebook.com/${version}/dialog/oauth` +
        `?client_id=${APP_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}` +
        (auth_type ? `&auth_type=${encodeURIComponent(auth_type)}` : '')

    return res.redirect(url)
}

// GET /api/auth/callback  → Meta llama aquí con ?code. Redirige al FRONT con ?token
export const authCallback = async (req: Request, res: Response) => {
    const { code, error, error_description } = req.query as any
    const FRONT = process.env.FRONT_CALLBACK_URL || 'https://wasaaa.com/dashboard/callback'

    if (error) {
        return res.redirect(
            `${FRONT}?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(error_description || '')}`
        )
    }
    if (!code) return res.status(400).json({ error: 'Falta el parámetro code' })

    try {
        const r = await axios.get<MetaTokenResponse>(`${GRAPH}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI, // Debe coincidir con el usado al iniciar
                code,
            },
        })
        const accessToken = r.data.access_token
        return res.redirect(`${FRONT}?token=${encodeURIComponent(accessToken)}`)
    } catch (e: any) {
        console.error('[authCallback] Meta error:', e.response?.data || e.message)
        return res.status(400).json({ error: 'Error autenticando con Meta' })
    }
}

// POST /api/auth/exchange-code  → (Opcional si el front recibe ?code)
export const exchangeCode = async (req: Request, res: Response) => {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: 'Missing code' })

    try {
        const r = await axios.get(`${GRAPH}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI,
                code,
            },
        })
        return res.json({ access_token: r.data.access_token })
    } catch (e: any) {
        console.error('[exchangeCode] Meta error:', e.response?.data || e.message)
        return res.status(400).json({ error: e.response?.data || e.message })
    }
}

/* =============================================================================
 * LISTAR BUSINESSES → WABAs → PHONES (para el CallbackPage)
 * ========================================================================== */

// GET /api/auth/wabas?token=...&debug=1
export const getWabasAndPhones = async (req: Request, res: Response) => {
    const token = (req.query.token as string) || ''
    const debug = req.query.debug === '1'
    if (!token) return res.status(400).json({ error: 'Missing user access token' })

    const fbGet = async (url: string, params: Record<string, any>) =>
        (await axios.get(url, { params })).data

    try {
        // 1) Validar permisos: los 3 obligatorios
        const perms = await fbGet(`${GRAPH}/me/permissions`, { access_token: token })
        const granted: string[] = (perms?.data || [])
            .filter((p: any) => p.status === 'granted')
            .map((p: any) => p.permission)
        const need = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging']
        const missing = need.filter((p) => !granted.includes(p))
        if (missing.length) {
            return res.status(403).json({ error: `Missing permissions: ${missing.join(', ')}` })
        }

        // 2) Businesses del usuario
        const b = await fbGet(`${GRAPH}/me/businesses`, { fields: 'id,name', access_token: token })
        const businesses = b?.data || []

        // 3) WABAs y Phones por business
        const items: { waba: any; phones: any[] }[] = []
        for (const biz of businesses) {
            const wabas = (await fbGet(`${GRAPH}/${biz.id}/owned_whatsapp_business_accounts`, {
                fields: 'id,name',
                access_token: token,
            }))?.data || []

            for (const w of wabas) {
                const phones = (await fbGet(`${GRAPH}/${w.id}/phone_numbers`, {
                    fields: 'id,display_phone_number',
                    access_token: token,
                }))?.data || []
                items.push({
                    waba: { id: w.id, name: w.name, owner_business_id: biz.id },
                    phones,
                })
            }
        }

        return res.json({ items, diagnostics: debug ? { businesses: businesses.length } : undefined })
    } catch (e: any) {
        const err = e?.response?.data?.error || { message: e.message }
        console.error('[getWabasAndPhones] error:', err)
        return res.status(500).json({ error: 'Error listando WABAs y teléfonos', meta: err })
    }
}

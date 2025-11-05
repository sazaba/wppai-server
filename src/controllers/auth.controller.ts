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

        // ▲ TRIAL de 7 días (parametrizable por env TRIAL_DAYS)
        const ahora = new Date()
        const trialDays = Number(process.env.TRIAL_DAYS ?? 7)
        const finPrueba = new Date(ahora.getTime() + trialDays * 24 * 60 * 60 * 1000)

        const empresa = await prisma.empresa.create({
            data: {
                nombre: nombreEmpresa,
                estado: 'activo',
                plan: 'gratis',        // ▲ plan gratuito por defecto
                trialStart: ahora,     // ▲ inicio del trial
                trialEnd: finPrueba,   // ▲ fin del trial (7 días por defecto)
                conversationsUsed: 0,  // ▲ contador en 0
                usuarios: {
                    create: { email, password: hashed, rol: 'admin' },
                },
                // 👇 OUTBOUND REMOVIDO: ya no se crea outboundConfig por defecto
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
    } catch (e: any) {
        // Manejo de email duplicado (P2002)
        if (e?.code === 'P2002' && e?.meta?.target?.includes('email')) {
            return res.status(409).json({ error: 'El email ya está registrado' })
        }
        console.error('[registrar] Error:', e)
        return res.status(500).json({ error: 'Error al registrar empresa' })
    }
}

/* =============================================================================
 * OAUTH META (FLUJO ÚNICO)
 * ========================================================================== */

// 1) Iniciar OAuth (redirige a Meta con redirect_uri FIJO del backend)
export const iniciarOAuthMeta = (req: Request, res: Response) => {
    const APP_ID = process.env.META_APP_ID!
    const REDIRECT_URI = process.env.META_REDIRECT_URI! // callback del BACKEND registrado en Meta
    const version = 'v20.0'
    const auth_type = (req.query.auth_type as string) || '' // ej: rerequest

    const scope = [
        'business_management',
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        // 'pages_show_list' // opcional
    ].join(',')

    const url =
        `https://www.facebook.com/${version}/dialog/oauth` +
        `?client_id=${APP_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` + // FIJO
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}` +
        (auth_type ? `&auth_type=${encodeURIComponent(auth_type)}` : '')

    return res.redirect(url)
}

// 2) Callback del BACKEND: intercambia code -> access_token y redirige al FRONT fijo
export const authCallback = async (req: Request, res: Response) => {
    const { code } = req.query
    if (!code) return res.status(400).json({ error: 'Falta el parámetro code' })

    try {
        const REDIRECT_URI = process.env.META_REDIRECT_URI!        // el mismo de arriba
        const FRONT_CALLBACK = process.env.FRONT_CALLBACK_URL      // e.g. https://wasaaa.com/dashboard/callback

        const tokenRes = await axios.get(`${GRAPH}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: REDIRECT_URI, // DEBE coincidir EXACTO
                code
            },
            headers: { 'Content-Type': 'application/json' }
        })

        const accessToken = tokenRes.data.access_token
        const front = FRONT_CALLBACK || 'https://wasaaa.com/dashboard/callback'
        return res.redirect(`${front}?token=${encodeURIComponent(accessToken)}`)
    } catch (err: any) {
        console.error('[authCallback] Error Meta:', err?.response?.data || err.message)
        return res.status(500).json({ error: '❌ Error autenticando con Meta.' })
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
            headers: { 'Content-Type': 'application/json' }
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
    const debug = String(req.query.debug || '') === '1'
    if (!token) return res.status(400).json({ error: 'Missing user access token' })

    // helper axios con token por defecto
    const api = axios.create({
        baseURL: GRAPH,
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json' }
    })

    const diagnostics: any = debug ? {} : undefined

    try {
        // 1) Validar permisos requeridos
        const permsResp = await api.get('/me/permissions')
        const granted: string[] = (permsResp.data?.data || [])
            .filter((p: any) => p.status === 'granted')
            .map((p: any) => p.permission)

        if (diagnostics) diagnostics.granted = granted

        const need = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging']
        const missing = need.filter((p) => !granted.includes(p))
        if (missing.length) {
            return res.status(403).json({ error: `Missing permissions: ${missing.join(', ')}`, diagnostics })
        }

        // 2) Listar negocios donde el usuario tiene rol
        let businesses: Array<{ id: string; name: string }> = []
        try {
            const bizResp = await api.get('/me/businesses', { params: { fields: 'id,name' } })
            businesses = bizResp.data?.data || []
        } catch (err: any) {
            if (diagnostics) diagnostics.businesses_error = err?.response?.data?.error || err?.message
        }
        if (diagnostics) diagnostics.businesses_count = businesses.length

        const items: Array<{ waba: any; phones: any[] }> = []

        // 3) Para cada negocio, obtener sus WABAs y teléfonos (llamadas atómicas)
        for (const biz of businesses) {
            try {
                const wabasResp = await api.get(`/${biz.id}/owned_whatsapp_business_accounts`, {
                    params: { fields: 'id,name' },
                })
                const wabas = wabasResp.data?.data || []

                for (const w of wabas) {
                    try {
                        const phonesResp = await api.get(`/${w.id}/phone_numbers`, {
                            params: { fields: 'id,display_phone_number' },
                        })
                        const phones = phonesResp.data?.data || []
                        items.push({
                            waba: { id: w.id, name: w.name, owner_business_id: biz.id },
                            phones: phones.map((p: any) => ({
                                id: p.id,
                                display_phone_number: p.display_phone_number,
                            })),
                        })
                    } catch (errPhones: any) {
                        if (diagnostics) {
                            diagnostics[`phones_error_${w.id}`] = errPhones?.response?.data?.error || errPhones?.message
                        }
                    }
                }
            } catch (errWabas: any) {
                if (diagnostics) {
                    diagnostics[`wabas_error_${biz.id}`] = errWabas?.response?.data?.error || errWabas?.message
                }
            }
        }

        // 4) Fallback: algunos setups no exponen businesses pero sí WABAs directas
        if (!items.length) {
            try {
                const ownWabas = await api.get('/me/owned_whatsapp_business_accounts', { params: { fields: 'id,name' } })
                const wabas = ownWabas.data?.data || []
                if (diagnostics) diagnostics.fallback_wabas_count = wabas.length

                for (const w of wabas) {
                    try {
                        const phonesResp = await api.get(`/${w.id}/phone_numbers`, {
                            params: { fields: 'id,display_phone_number' },
                        })
                        const phones = phonesResp.data?.data || []
                        items.push({
                            waba: { id: w.id, name: w.name, owner_business_id: undefined },
                            phones: phones.map((p: any) => ({
                                id: p.id,
                                display_phone_number: p.display_phone_number,
                            })),
                        })
                    } catch (errPhones: any) {
                        if (diagnostics) {
                            diagnostics[`phones_error_${w.id}`] = errPhones?.response?.data?.error || errPhones?.message
                        }
                    }
                }
            } catch (errFallback: any) {
                if (diagnostics) diagnostics.fallback_error = errFallback?.response?.data?.error || errFallback?.message
            }
        }

        return res.json({ items, diagnostics })
    } catch (e: any) {
        const err = e?.response?.data?.error || { message: e.message }
        console.error('[getWabasAndPhones] error:', err)
        return res.status(500).json({ error: 'Error listando WABAs y teléfonos', meta: err })
    }
}

import axios from 'axios'
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import bcrypt from 'bcrypt'
import { generarToken } from '../utils/jwt'
import jwt, { JwtPayload as DefaultJwtPayload } from 'jsonwebtoken'

interface CustomJwtPayload extends DefaultJwtPayload {
    empresaId: number
}

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

        console.log('✅ [LOGIN] Contraseña válida')

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

// ✅ Registro: crea empresa + usuario admin
export const registrar = async (req: Request, res: Response) => {
    const { nombreEmpresa, email, password } = req.body

    if (!nombreEmpresa || !email || !password) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' })
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10)

        const empresa = await prisma.empresa.create({
            data: {
                nombre: nombreEmpresa,
                estado: 'inactivo',
                usuarios: {
                    create: {
                        email,
                        password: hashedPassword,
                        rol: 'admin'
                    }
                }
            },
            include: {
                usuarios: true
            }
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

// 🔁 Nuevo flujo authCallback con selección de número
export const authCallback = async (req: Request, res: Response) => {
    const { code } = req.body
    const authHeader = req.headers.authorization

    if (!code || !authHeader) {
        return res.status(400).json({ error: 'Faltan code o token' })
    }

    const token = authHeader.split(' ')[1]
    if (!token) {
        return res.status(400).json({ error: 'Token no proporcionado' })
    }

    let empresaId: number
    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET as string
        ) as CustomJwtPayload

        if (!decoded.empresaId) {
            return res.status(401).json({ error: 'Token inválido: falta empresaId' })
        }

        empresaId = decoded.empresaId
    } catch (err) {
        console.error('❌ Token inválido en callback')
        return res.status(401).json({ error: 'Token inválido' })
    }

    try {
        // 🔐 Paso 1: Obtener access_token
        const tokenRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI,
                code
            }
        })

        const accessToken = tokenRes.data.access_token

        // 🔎 Paso 2: Obtener negocios del usuario
        const businessRes = await axios.get(`https://graph.facebook.com/v20.0/me/businesses`, {
            params: { access_token: accessToken }
        })

        const businesses = businessRes.data.data
        let availableNumbers: any[] = []

        for (const business of businesses) {
            const businessId = business.id

            // 📦 Obtener cuentas de WhatsApp del negocio
            const wabaRes = await axios.get(`https://graph.facebook.com/v20.0/${businessId}/owned_whatsapp_business_accounts`, {
                params: { access_token: accessToken }
            })

            const wabas = wabaRes.data.data

            for (const waba of wabas) {
                const wabaId = waba.id

                const phoneRes = await axios.get(`https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`, {
                    params: { access_token: accessToken }
                })

                const phoneNumbers = phoneRes.data.data

                for (const phone of phoneNumbers) {
                    availableNumbers.push({
                        negocioId: businessId,
                        wabaId,
                        phoneNumberId: phone.id,
                        nombre: phone.name,
                        displayPhoneNumber: phone.display_phone_number
                    })
                }
            }
        }

        if (availableNumbers.length === 0) {
            return res.status(400).json({ error: 'No se encontraron números disponibles' })
        }

        return res.json({ seleccionarNumero: true, availableNumbers, accessToken })
    } catch (err: any) {
        console.error('[authCallback] Error Meta:', err.response?.data || err.message)
        return res.status(500).json({ error: '❌ Error autenticando con Meta.' })
    }
}

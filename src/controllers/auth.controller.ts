import axios from 'axios'
import { Request, Response } from 'express'
import prisma from '../lib/prisma'
import bcrypt from 'bcrypt'
import { generarToken } from '../utils/jwt'

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

// ✅ OAuth callback: guarda accessToken y phoneNumberId vinculados a la empresa autenticada
export const authCallback = async (req: Request, res: Response) => {
    const code = req.query.code as string
    const state = req.query.state as string
    const empresaId = parseInt(state)

    if (!code || !empresaId) {
        return res.status(400).send('Faltan datos: code o empresaId no válidos.')
    }

    try {
        // Paso 1: Obtener access token
        const tokenRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: process.env.META_REDIRECT_URI,
                code
            }
        })

        const accessToken = tokenRes.data.access_token

        // Paso 2: Obtener el ID del usuario o negocio conectado
        const businessRes = await axios.get('https://graph.facebook.com/v20.0/me', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        })

        const userId = businessRes.data.id

        // Paso 3: Obtener el phone_number_id del número de WhatsApp conectado
        const phoneRes = await axios.get(
            `https://graph.facebook.com/v20.0/${userId}/owned_phone_numbers?fields=id`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        )

        const phoneNumberId = phoneRes.data?.data?.[0]?.id

        if (!phoneNumberId) {
            return res.status(400).send('No se pudo obtener el phone_number_id del número vinculado.')
        }

        // Paso 4: Guardar o actualizar la cuenta de WhatsApp vinculada con la empresa
        await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: { phoneNumberId, accessToken },
            create: { empresaId, phoneNumberId, accessToken }
        })

        return res.send(`✅ Número de WhatsApp vinculado correctamente. phone_number_id: ${phoneNumberId}`)
    } catch (err: any) {
        console.error('[authCallback] Error:', err.response?.data || err.message)
        return res.status(500).send('❌ Error autenticando con Meta.')
    }
}

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

interface MetaTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
}

// 🔁 Nuevo flujo authCallback con número y phone_number_id manual
export const authCallback = async (req: Request, res: Response) => {
    const { code, state } = req.query

    if (!code || !state) {
        return res.status(400).json({ error: 'Faltan code o state' })
    }

    try {
        // Extraer empresaId, número y phone_number_id desde el state
        const [empresaIdStr, numeroTelefono, phoneNumberId] = decodeURIComponent(state as string).split("|")

        if (!empresaIdStr || !numeroTelefono || !phoneNumberId) {
            return res.status(400).json({ error: 'State inválido: falta empresaId, número o phone_number_id' })
        }

        const empresaId = parseInt(empresaIdStr, 10)
        if (isNaN(empresaId)) {
            return res.status(400).json({ error: 'empresaId inválido' })
        }

        // 🔐 Paso 1: Obtener access_token de Meta
        const tokenRes = await axios.get<MetaTokenResponse>(
            'https://graph.facebook.com/v20.0/oauth/access_token',
            {
                params: {
                    client_id: process.env.META_APP_ID,
                    client_secret: process.env.META_APP_SECRET,
                    redirect_uri: process.env.META_REDIRECT_URI,
                    code
                }
            }
        )

        const accessToken: string = tokenRes.data.access_token

        // 💾 Paso 2: Guardar o actualizar en la base de datos
        await prisma.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                displayPhoneNumber: numeroTelefono,
                phoneNumberId,
                accessToken
            },
            create: {
                phoneNumberId,
                wabaId: "",
                businessId: "",
                displayPhoneNumber: numeroTelefono,
                accessToken,
                empresaId
            }
        })

        console.log(`✅ [authCallback] Número ${numeroTelefono} (${phoneNumberId}) conectado para empresa ${empresaId}`)

        // Redirigir con éxito al dashboard
        return res.redirect(`https://wasaaa.com/dashboard/callback?success=1`)
    } catch (err: any) {
        console.error('[authCallback] Error Meta:', err.response?.data || err.message)
        return res.status(500).json({ error: '❌ Error autenticando con Meta.' })
    }
}

// src/utils/jwt.ts
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto'

export const generarToken = (payload: {
    id: number
    email: string
    rol: string
    empresaId: number
}) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

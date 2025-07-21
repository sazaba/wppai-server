// src/types/express/index.d.ts

import { Rol } from '@prisma/client'

declare namespace Express {
    export interface Request {
        user?: {
            id: number
            email: string
            rol: Rol
            empresaId: number
        }
    }
}

export { } // 👈 Esto es obligatorio para que el archivo se registre correctamente

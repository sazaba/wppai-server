import { BusinessConfig } from '@prisma/client'

export function contienePalabraClave(mensaje: string, palabrasClave: string): boolean {
    const claves = palabrasClave
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)

    return claves.some((clave) => mensaje.toLowerCase().includes(clave))
}

export function shouldEscalateChat({
    mensaje,
    config,
    iaConfianzaBaja,
    intentosFallidos
}: {
    mensaje: string
    config: BusinessConfig
    iaConfianzaBaja: boolean
    intentosFallidos: number
}): 'confianza_baja' | 'palabra_clave' | 'reintentos' | null {
    if (config.escalarSiNoConfia && iaConfianzaBaja) {
        console.log('[ESCALAR] Por baja confianza de IA')
        return 'confianza_baja'
    }

    if (
        config.escalarPalabrasClave &&
        contienePalabraClave(mensaje, config.escalarPalabrasClave)
    ) {
        console.log('[ESCALAR] Por palabra clave detectada')
        return 'palabra_clave'
    }

    if (
        config.escalarPorReintentos &&
        intentosFallidos >= config.escalarPorReintentos
    ) {
        console.log(`[ESCALAR] Por reintentos fallidos (${intentosFallidos}) >= (${config.escalarPorReintentos})`)
        return 'reintentos'
    }

    console.log('[NO ESCALAR] Mensaje no cumple criterios de escalamiento')
    return null
}

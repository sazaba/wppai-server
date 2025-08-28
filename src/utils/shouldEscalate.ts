// server/src/utils/shouldEscalate.ts
import { BusinessConfig } from '@prisma/client'

/** Normaliza y quita acentos para comparar */
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/** true si alguna palabra clave aparece en el mensaje */
export function contienePalabraClave(mensaje: string, palabrasClave?: string | null): boolean {
  if (!palabrasClave?.trim()) return false
  const msg = norm(mensaje)
  const claves = palabrasClave
    .split(/[;,]/) // admite coma o punto y coma
    .map(p => norm(p).trim())
    .filter(Boolean)

  return claves.some(clave => msg.includes(clave))
}

/**
 * Reglas de escalamiento:
 * - 'confianza_baja' si config.escalarSiNoConfia && iaConfianzaBaja
 * - 'palabra_clave' si coincide alguna en config.escalarPalabrasClave
 * - 'reintentos'    si intentosFallidos >= config.escalarPorReintentos (y > 0)
 */
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

  if (contienePalabraClave(mensaje, config.escalarPalabrasClave)) {
    console.log('[ESCALAR] Por palabra clave detectada')
    return 'palabra_clave'
  }

  if (config.escalarPorReintentos > 0 && intentosFallidos >= config.escalarPorReintentos) {
    console.log(`[ESCALAR] Por reintentos fallidos (${intentosFallidos}) >= (${config.escalarPorReintentos})`)
    return 'reintentos'
  }

  console.log('[NO ESCALAR] Mensaje no cumple criterios de escalamiento')
  return null
}

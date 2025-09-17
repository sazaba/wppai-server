"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contienePalabraClave = contienePalabraClave;
exports.shouldEscalateChat = shouldEscalateChat;
/** Normaliza y quita acentos para comparar */
function norm(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}
/** true si alguna palabra clave aparece en el mensaje */
function contienePalabraClave(mensaje, palabrasClave) {
    if (!palabrasClave?.trim())
        return false;
    const msg = norm(mensaje);
    const claves = palabrasClave
        .split(/[;,]/) // admite coma o punto y coma
        .map(p => norm(p).trim())
        .filter(Boolean);
    return claves.some(clave => msg.includes(clave));
}
/**
 * Reglas de escalamiento:
 * - 'confianza_baja' si config.escalarSiNoConfia && iaConfianzaBaja
 * - 'palabra_clave' si coincide alguna en config.escalarPalabrasClave
 * - 'reintentos'    si intentosFallidos >= config.escalarPorReintentos (y > 0)
 */
function shouldEscalateChat({ mensaje, config, iaConfianzaBaja, intentosFallidos }) {
    if (config.escalarSiNoConfia && iaConfianzaBaja) {
        console.log('[ESCALAR] Por baja confianza de IA');
        return 'confianza_baja';
    }
    if (contienePalabraClave(mensaje, config.escalarPalabrasClave)) {
        console.log('[ESCALAR] Por palabra clave detectada');
        return 'palabra_clave';
    }
    if (config.escalarPorReintentos > 0 && intentosFallidos >= config.escalarPorReintentos) {
        console.log(`[ESCALAR] Por reintentos fallidos (${intentosFallidos}) >= (${config.escalarPorReintentos})`);
        return 'reintentos';
    }
    console.log('[NO ESCALAR] Mensaje no cumple criterios de escalamiento');
    return null;
}

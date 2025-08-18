// src/router-debug.ts
import { Router as ExpressRouter } from 'express'

/**
 * Router de depuración.
 * Loguea cada path string/array que se intenta registrar y no rompe los tipos.
 */
export function Router() {
    const r = ExpressRouter()

    const methods = [
        'get',
        'post',
        'put',
        'patch',
        'delete',
        'options',
        'head',
        'all',
        'use',
    ] as const

    for (const m of methods) {
        // Guardamos el método original (con cast para evitar problemas de sobrecarga)
        const orig = (r as any)[m].bind(r) as (...args: any[]) => any

            // Reemplazamos el método por nuestro wrapper con tipos "sueltos"
            ; (r as any)[m] = (...args: any[]) => {
                try {
                    const first = args[0]
                    const paths: string[] = []

                    if (typeof first === 'string') {
                        paths.push(first)
                    } else if (Array.isArray(first)) {
                        for (const p of first) if (typeof p === 'string') paths.push(p)
                    }
                    // Si es RegExp o middleware como primer argumento, no imprimimos.

                    if (paths.length) {
                        console.log(`[ROUTE ${m.toUpperCase()}]`, paths.join(', '))
                    }

                    // Llamamos al original (cast a any para permitir ...args sin quejarse)
                    return (orig as any)(...args)
                } catch (e: any) {
                    // Imprime lo que se intentó registrar si path-to-regexp explota
                    let shown = ''
                    try {
                        shown = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])
                    } catch {
                        shown = String(args[0])
                    }
                    console.error(`[ROUTE ${m.toUpperCase()} ERROR]`, shown, e)
                    throw e
                }
            }
    }

    return r
}

export default Router

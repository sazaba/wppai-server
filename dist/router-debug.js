"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = Router;
// src/router-debug.ts
const express_1 = require("express");
/**
 * Router de depuración.
 * Loguea cada path string/array que se intenta registrar y no rompe los tipos.
 */
function Router() {
    const r = (0, express_1.Router)();
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
    ];
    for (const m of methods) {
        // Guardamos el método original (con cast para evitar problemas de sobrecarga)
        const orig = r[m].bind(r);
        r[m] = (...args) => {
            try {
                const first = args[0];
                const paths = [];
                if (typeof first === 'string') {
                    paths.push(first);
                }
                else if (Array.isArray(first)) {
                    for (const p of first)
                        if (typeof p === 'string')
                            paths.push(p);
                }
                // Si es RegExp o middleware como primer argumento, no imprimimos.
                if (paths.length) {
                    console.log(`[ROUTE ${m.toUpperCase()}]`, paths.join(', '));
                }
                // Llamamos al original (cast a any para permitir ...args sin quejarse)
                return orig(...args);
            }
            catch (e) {
                // Imprime lo que se intentó registrar si path-to-regexp explota
                let shown = '';
                try {
                    shown = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
                }
                catch {
                    shown = String(args[0]);
                }
                console.error(`[ROUTE ${m.toUpperCase()} ERROR]`, shown, e);
                throw e;
            }
        };
    }
    return r;
}
exports.default = Router;

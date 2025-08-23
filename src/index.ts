
// import express from 'express'
// import cors from 'cors'
// import dotenv from 'dotenv'
// import http from 'http'
// import { Server } from 'socket.io'

// import configRoutes from './routes/config.routes'
// import webhookRoutes from './routes/webhook.route'
// import chatRoutes from './routes/chat.route'
// import authRoutes from './routes/auth.route'
// import whatsappRoutes from './routes/whatsapp.routes'
// import empresaRoutes from './routes/empresa.routes'
// import messageTemplateRoutes from './routes/template.routes'
// import productRoutes from './routes/product.routes'

// // 📦 Cargar variables de entorno
// dotenv.config()

// // 🚀 Inicializar servidor Express
// const app = express()

// // 🌐 Orígenes permitidos
// const allowedOrigins = [
//     'https://wppai-client.vercel.app',
//     'https://www.wasaaa.com',
//     'http://localhost:3000',
//     'https://wasaaa.com',
// ]

// // 🧠 Servidor HTTP + WebSocket
// const server = http.createServer(app)
// const io = new Server(server, {
//     cors: {
//         origin: allowedOrigins,
//         credentials: true,
//     },
// })
// app.set('io', io)

// // ✅ Confiar en proxy (Render/Cloudflare) para X-Forwarded-*
// app.set('trust proxy', 1)

// // 🔌 WebSocket conectado
// io.on('connection', (socket) => {
//     console.log('🔌 Cliente conectado vía WebSocket')
//     socket.on('disconnect', () => {
//         console.log('❌ Cliente desconectado')
//     })
// })

// // 🌐 Middlewares
// app.use(
//     cors({
//         origin: (origin, callback) => {
//             if (!origin || allowedOrigins.includes(origin)) {
//                 callback(null, true)
//             } else {
//                 console.warn('❌ [CORS] Origen no permitido:', origin)
//                 callback(new Error('No permitido por CORS'))
//             }
//         },
//         credentials: true,
//         // 👇 añade métodos y headers para Authorization (no afecta tu flujo actual)
//         methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//         allowedHeaders: ['Content-Type', 'Authorization'],
//         exposedHeaders: ['Content-Length'],
//     }),
// )
// // ⬇️ Pon esto DESPUÉS de app.use(cors(...)) y ANTES de registrar routers protegidos
// app.use((req, res, next) => {
//     // BYPASS total para el stream de media
//     if (req.method === 'GET' && /^\/api\/whatsapp\/media\//.test(req.path)) {
//         return next();
//     }
//     return next();
// });


// app.use(express.urlencoded({ extended: true }))
// app.use(express.json({ type: 'application/json', limit: '5mb' }))

// // 📌 Rutas públicas
// app.use('/api/auth', authRoutes) // login, registro, OAuth
// app.use('/api/webhook', webhookRoutes)
// app.use('/api/whatsapp', whatsappRoutes) // conexión de cuenta WhatsApp por empresa

// // 🔐 Rutas protegidas (JWT middleware dentro de cada archivo)
// app.use('/api/products', productRoutes)
// app.use('/api/config', configRoutes) // configuración del negocio
// app.use('/api', chatRoutes) // historial, estados, IA


// // empresa
// app.use('/api', empresaRoutes)
// app.use('/api/templates', messageTemplateRoutes)

// // 🧼 Logger 404 temporal (no responde; evita imprimir query para no filtrar ?t=)
// app.use((req, _res, _next) => {
//     const url = req.originalUrl.split('?')[0]
//     console.log('[404]', req.method, url)
//     _next()
// })

// // 🏠 Ruta raíz
// app.get('/', (_req, res) => {
//     res.send('🚀 Backend de Chat IA corriendo correctamente')
// })

// // ✅ Printer de rutas a prueba de producción
// function printRoutesSafe(app: any) {
//     try {
//         const root = app && app._router
//         if (!root || !root.stack) {
//             console.log('🧭 (no hay _router.stack disponible; omito listado)')
//             return
//         }

//         const walk = (layer: any, prefix = '') => {
//             if (layer.route && layer.route.path) {
//                 const methods = Object.keys(layer.route.methods || {})
//                     .map((m) => m.toUpperCase())
//                     .join(',')
//                 console.log(`➡️  ${methods.padEnd(6)} ${prefix}${layer.route.path}`)
//             } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
//                 // Intento razonable de recuperar el mountpath (sin romper en prod)
//                 let mount = ''
//                 if (layer.regexp && layer.regexp.source) {
//                     // ej: ^\/api\/whatsapp\/?(?=\/|$)
//                     const match = layer.regexp.source
//                         .replace(/\\\//g, '/')
//                         .match(/^\^\\?\/(.*)\\\/\?\(\?=\\\/\|\$\)\$/)
//                     mount = match && match[1] ? '/' + match[1] : ''
//                 }
//                 for (const l of layer.handle.stack) {
//                     walk(l, `${prefix}${mount}`)
//                 }
//             }
//         }

//         for (const layer of root.stack) walk(layer, '')
//     } catch (e: any) {
//         console.log('🧭 (error imprimiendo rutas, omito):', e?.message || e)
//     }
// }

// // 🟢 Iniciar servidor
// const PORT = process.env.PORT || 4000
// server.listen(PORT, () => {
//     console.log(`✅ API escuchando en http://localhost:${PORT}`)
//     console.log('🧭 Rutas registradas:')
//     printRoutesSafe(app)
// })


// src/index.ts
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server } from 'socket.io'
import compression from 'compression'

// Rutas
import configRoutes from './routes/config.routes'
import webhookRoutes from './routes/webhook.route'
import chatRoutes from './routes/chat.route'
import authRoutes from './routes/auth.route'
import whatsappRoutes from './routes/whatsapp.routes'
import empresaRoutes from './routes/empresa.routes'
import messageTemplateRoutes from './routes/template.routes'
import productRoutes from './routes/product.routes'

// 📦 Cargar variables de entorno
dotenv.config()

// 🌐 Orígenes permitidos (ENV: ALLOWED_ORIGINS=foo.com,bar.com)
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

const allowedOrigins = new Set<string>([
    // Defaults tuyos
    'https://wppai-client.vercel.app',
    'https://www.wasaaa.com',
    'https://wasaaa.com',
    'http://localhost:3000',
    // Agrega por ENV
    ...ENV_ALLOWED,
])

// helper: permite subdominios *.vercel.app si lo necesitas
const dynamicAllowed = (origin?: string | null) => {
    if (!origin) return true // permite herramientas como curl/Postman
    try {
        const u = new URL(origin)
        if (allowedOrigins.has(origin)) return true
        // whitelists convenientes
        if (u.hostname === 'localhost') return true
        if (u.hostname.endsWith('.vercel.app')) return true
        if (u.hostname.endsWith('.wasaaa.com')) return true
    } catch { /* ignore parse */ }
    return false
}

// 🚀 Inicializar servidor Express
const app = express()

// 🧠 Servidor HTTP + WebSocket
const server = http.createServer(app)
const io = new Server(server, {
    path: process.env.SOCKET_IO_PATH || '/socket.io',
    cors: {
        origin: (origin, cb) => {
            if (dynamicAllowed(origin)) return cb(null, true)
            console.warn('❌ [Socket.IO CORS] Origen no permitido:', origin)
            cb(new Error('Socket.IO CORS blocked'))
        },
        credentials: true,
    },
    // más resiliencia tras proxy (Render/Cloudflare)
    pingInterval: 25000,
    pingTimeout: 60000,
})
app.set('io', io)

// ✅ Confiar en proxy (Render/Cloudflare) para X-Forwarded-*
app.set('trust proxy', 1)

// 🔌 WebSocket conectado
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket')
    socket.on('disconnect', (reason) => {
        console.log('❌ Cliente desconectado:', reason)
    })
})

// 🌐 Middlewares base
app.use(compression())

app.use(
    cors({
        origin: (origin, callback) => {
            if (dynamicAllowed(origin)) return callback(null, true)
            console.warn('❌ [HTTP CORS] Origen no permitido:', origin)
            callback(new Error('No permitido por CORS'))
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length'],
    }),
)
// Preflight explícito (algunos proxies lo agradecen)
app.options('*', cors())

// Bypass específico (mantén tu excepción de media WhatsApp)
app.use((req, _res, next) => {
    if (req.method === 'GET' && /^\/api\/whatsapp\/media\//.test(req.path)) {
        return next()
    }
    return next()
})

app.use(express.urlencoded({ extended: true }))
app.use(express.json({ type: 'application/json', limit: '5mb' }))

// 🏥 Healthchecks (Render)
app.get('/healthz', (_req, res) => res.status(200).send('ok'))
app.get('/readyz', (_req, res) => res.status(200).send('ready'))

// 🏠 Ruta raíz
app.get('/', (_req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente')
})

// 📌 Rutas públicas
app.use('/api/auth', authRoutes) // login, registro, OAuth
app.use('/api/webhook', webhookRoutes)
app.use('/api/whatsapp', whatsappRoutes) // conexión de cuenta WhatsApp por empresa

// 🔐 Rutas protegidas (JWT middleware dentro de cada archivo)
app.use('/api/products', productRoutes)
app.use('/api/config', configRoutes) // configuración del negocio
app.use('/api', chatRoutes) // historial, estados, IA
app.use('/api', empresaRoutes)
app.use('/api/templates', messageTemplateRoutes)

// 404 JSON (después de las rutas)
app.use((req, res, _next) => {
    const url = req.originalUrl.split('?')[0]
    console.log('[404]', req.method, url)
    res.status(404).json({ error: 'Not Found' })
})

// Handler de errores (CORS, JSON parser, etc.)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const code = err?.status || 500
    const msg = err?.message || 'Internal Server Error'
    if (code >= 500) console.error('[500]', err)
    res.status(code).json({ error: msg })
})

// ✅ Printer de rutas (solo log; no crítico en prod)
function printRoutesSafe(app: any) {
    try {
        const root = app && app._router
        if (!root || !root.stack) {
            console.log('🧭 (no hay _router.stack disponible; omito listado)')
            return
        }
        const walk = (layer: any, prefix = '') => {
            if (layer.route && layer.route.path) {
                const methods = Object.keys(layer.route.methods || {})
                    .map((m) => m.toUpperCase())
                    .join(',')
                console.log(`➡️  ${methods.padEnd(6)} ${prefix}${layer.route.path}`)
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                let mount = ''
                if (layer.regexp && layer.regexp.source) {
                    const match = layer.regexp.source
                        .replace(/\\\//g, '/')
                        .match(/^\^\\?\/(.*)\\\/\?\(\?=\\\/\|\$\)\$/)
                    mount = match && match[1] ? '/' + match[1] : ''
                }
                for (const l of layer.handle.stack) walk(l, `${prefix}${mount}`)
            }
        }
        for (const layer of root.stack) walk(layer, '')
    } catch (e: any) {
        console.log('🧭 (error imprimiendo rutas, omito):', e?.message || e)
    }
}

// 🟢 Iniciar servidor
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
    console.log('🧭 Rutas registradas:')
    printRoutesSafe(app)
})

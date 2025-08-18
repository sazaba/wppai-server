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

// // 📦 Cargar variables de entorno
// dotenv.config()

// // 🚀 Inicializar servidor Express
// const app = express()

// // 🌐 Orígenes permitidos
// const allowedOrigins = [
//     'https://wppai-client.vercel.app',
//     'https://www.wasaaa.com',
//     'http://localhost:3000',
//     'https://wasaaa.com'
// ]

// // 🧠 Servidor HTTP + WebSocket
// const server = http.createServer(app)
// const io = new Server(server, {
//     cors: {
//         origin: allowedOrigins,
//         credentials: true
//     }
// })
// app.set('io', io)

// // Confianza en proxy (Render/Cloudflare) para X-Forwarded-*
// app.set('trust proxy', 1)

// // 🔌 WebSocket conectado
// io.on('connection', (socket) => {
//     console.log('🔌 Cliente conectado vía WebSocket')
//     socket.on('disconnect', () => {
//         console.log('❌ Cliente desconectado')
//     })
// })

// // 🌐 Middlewares
// app.use(cors({
//     origin: (origin, callback) => {
//         if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
//         console.warn('❌ [CORS] Origen no permitido:', origin)
//         return callback(new Error('No permitido por CORS'))
//     },
//     credentials: true,
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
//     exposedHeaders: ['Content-Length']
// }))

// // Preflight global para evitar 401 en OPTIONS
// app.options('*', cors({
//     origin: (origin, callback) => {
//         if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
//         return callback(new Error('No permitido por CORS'))
//     },
//     credentials: true,
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization']
// }))

// app.use(express.urlencoded({ extended: true }))
// app.use(express.json({ type: 'application/json', limit: '5mb' }))

// // 📌 Rutas públicas
// app.use('/api/auth', authRoutes)       // login, registro, OAuth
// app.use('/api/webhook', webhookRoutes)

// // 🔐 Rutas protegidas (JWT middleware dentro de cada archivo)
// app.use('/api/config', configRoutes)         // configuración del negocio
// app.use('/api', chatRoutes)                  // historial, estados, IA
// app.use('/api/whatsapp', whatsappRoutes)     // conexión de cuenta WhatsApp por empresa
// app.use('/api', empresaRoutes)
// app.use('/api/templates', messageTemplateRoutes)

// // 🏠 Ruta raíz
// app.get('/', (_req, res) => {
//     res.send('🚀 Backend de Chat IA corriendo correctamente')
// })

// // Temporal: logger 404 (no responde, deja continuar al handler final)
// app.use((req, _res, next) => {
//     console.log('[404]', req.method, req.originalUrl)
//     next()
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
//                 let mount = ''
//                 if (layer.regexp && layer.regexp.source) {
//                     const match = layer.regexp.source
//                         .replace(/\\\//g, '/')
//                         .match(/^\^\\?\/(.*)\\\/\?\(\?=\\\/\|\$\)\$/)
//                     mount = match && match[1] ? '/' + match[1] : ''
//                 }
//                 for (const l of layer.handle.stack) walk(l, `${prefix}${mount}`)
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


import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server } from 'socket.io'

import configRoutes from './routes/config.routes'
import webhookRoutes from './routes/webhook.route'
import chatRoutes from './routes/chat.route'
import authRoutes from './routes/auth.route'
import whatsappRoutes from './routes/whatsapp.routes'
import empresaRoutes from './routes/empresa.routes'
import messageTemplateRoutes from './routes/template.routes'

// 📦 Cargar variables de entorno
dotenv.config()

// 🚀 Inicializar servidor Express
const app = express()

// 🌐 Orígenes permitidos
const allowedOrigins = [
    'https://wppai-client.vercel.app',
    'https://www.wasaaa.com',
    'http://localhost:3000',
    'https://wasaaa.com',
]

// 🧠 Servidor HTTP + WebSocket
const server = http.createServer(app)
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
    },
})
app.set('io', io)

// Confianza en proxy (Render/Cloudflare) para X-Forwarded-*
app.set('trust proxy', 1)

// 🔌 WebSocket conectado
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket')
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado')
    })
})

// 🌐 Middlewares
app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
            console.warn('❌ [CORS] Origen no permitido:', origin)
            return callback(new Error('No permitido por CORS'))
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length'],
    }),
)

// Preflight global para evitar 401 en OPTIONS
app.options(
    '*',
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
            return callback(new Error('No permitido por CORS'))
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }),
)

app.use(express.urlencoded({ extended: true }))
app.use(express.json({ type: 'application/json', limit: '5mb' }))

/** 🧪 Helper de debug: monta routers con try/catch y loguea el mountpath */
function safeUse(appRef: any, mountPath: string, router: any) {
    try {
        appRef.use(mountPath, router)
        console.log('[MOUNT OK]', mountPath)
    } catch (e) {
        console.error('[MOUNT ERROR]', mountPath, e)
        throw e
    }
}

// 📌 Rutas públicas
safeUse(app, '/api/auth', authRoutes) // login, registro, OAuth
safeUse(app, '/api/webhook', webhookRoutes)

// 🔐 Rutas protegidas (JWT middleware dentro de cada archivo)
safeUse(app, '/api/config', configRoutes) // configuración del negocio
safeUse(app, '/api', chatRoutes) // historial, estados, IA
safeUse(app, '/api/whatsapp', whatsappRoutes) // conexión de cuenta WhatsApp por empresa
safeUse(app, '/api', empresaRoutes)
safeUse(app, '/api/templates', messageTemplateRoutes)

// 🏠 Ruta raíz
app.get('/', (_req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente')
})

// Temporal: logger 404 (NO imprime la query para no filtrar tokens en ?t=)
app.use((req, _res, next) => {
    const url = req.originalUrl.split('?')[0]
    console.log('[404]', req.method, url)
    next()
})

// ✅ Printer de rutas a prueba de producción
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
const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
    console.log('🧭 Rutas registradas:')
    printRoutesSafe(app)
})

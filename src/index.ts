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
    cors: { origin: allowedOrigins, credentials: true },
})
app.set('io', io)

// Confiar en proxy (Render/Cloudflare) para X-Forwarded-*
app.set('trust proxy', 1)

// 🔌 WebSocket
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket')
    socket.on('disconnect', () => console.log('❌ Cliente desconectado'))
})

// 🌐 CORS
app.use(
    cors({
        origin: (origin, cb) =>
            !origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error('No permitido por CORS')),
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length'],
        optionsSuccessStatus: 204,
    }),
)

// ✅ Preflight global seguro (evita bug de path-to-regexp con '*')
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
})

app.use(express.urlencoded({ extended: true }))
app.use(express.json({ type: 'application/json', limit: '5mb' }))

// 📌 Rutas públicas
app.use('/api/auth', authRoutes)        // login, registro, OAuth
app.use('/api/webhook', webhookRoutes)  // webhook de Meta

// 🔐 Rutas protegidas (JWT en cada router)
app.use('/api/config', configRoutes)          // configuración del negocio
app.use('/api', chatRoutes)                   // historial, estados, IA
app.use('/api/whatsapp', whatsappRoutes)      // WhatsApp
app.use('/api', empresaRoutes)                // empresa
app.use('/api/templates', messageTemplateRoutes) // plantillas

// 🏠 Root
app.get('/', (_req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente')
})

// 🧼 Logger 404 (sin query para no exponer ?t=…)
if (process.env.NODE_ENV !== 'production') {
    app.use((req, _res, next) => {
        const url = req.originalUrl.split('?')[0]
        console.log('[404]', req.method, url)
        next()
    })
}

// 🟢 Iniciar servidor
const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
})

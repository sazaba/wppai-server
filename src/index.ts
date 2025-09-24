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
import mediaProxyRouter from './routes/mediaProxy.route'
import ordersRouter from "./routes/orders.routes"
import paymentsRouter from "./routes/payments.routes"
import registerRoutes from './routes/whatsapp.register.routes'
// Agenda 
import appointmentsRoutes from './routes/appointments.routes'
import appointmentHoursRoutes from './routes/appointmentHours.routes'
import esteticaConfigRoutes from "./routes/estetica.config.routes";


// 📦 Cargar variables de entorno
dotenv.config()

// Normaliza y valida un path (evita valores estilo URL completas)
function sanitizePath(input?: string, fallback: string = '/socket.io') {
    if (!input) return fallback
    try {
        const u = new URL(input)
        return fallback
    } catch {
        return input.startsWith('/') ? input : `/${input}`
    }
}

// 🌐 Orígenes permitidos
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

const allowedOrigins = new Set<string>([
    'https://wppai-client.vercel.app',
    'https://www.wasaaa.com',
    'https://wasaaa.com',
    'http://localhost:3000',
    ...ENV_ALLOWED,
])

const dynamicAllowed = (origin?: string | null) => {
    if (!origin) return true
    try {
        const u = new URL(origin)
        if (allowedOrigins.has(origin)) return true
        if (u.hostname === 'localhost') return true
        if (u.hostname.endsWith('.vercel.app')) return true
        if (u.hostname.endsWith('.wasaaa.com')) return true
    } catch { /* noop */ }
    return false
}

// 🚀 Inicializar servidor Express
const app = express()

// 🧠 Servidor HTTP + WebSocket
const server = http.createServer(app)
const socketPath = sanitizePath(process.env.SOCKET_IO_PATH, '/socket.io')

const io = new Server(server, {
    path: socketPath,
    cors: {
        origin: (origin, cb) => {
            if (dynamicAllowed(origin)) return cb(null, true)
            console.warn('❌ [Socket.IO CORS] Origen no permitido:', origin)
            cb(new Error('Socket.IO CORS blocked'))
        },
        credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
})
app.set('io', io)

// ✅ Confiar en proxy (Render/Cloudflare)
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
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'x-appt-intent',
            'x-estetica-intent',
            // 👇 añade estos dos
            'cache-control',
            'pragma',
        ],
        exposedHeaders: ['Content-Length'],
    })
)


app.use(express.urlencoded({ extended: true }))
app.use(express.json({ type: 'application/json', limit: '5mb' }))

// 🏥 Healthchecks
app.get('/healthz', (_req, res) => res.status(200).send('ok'))
app.get('/readyz', (_req, res) => res.status(200).send('ready'))

// 🏠 Ruta raíz
app.get('/', (_req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente')
})

// 📌 Rutas públicas
app.use('/api/auth', authRoutes)
app.use('/api/webhook', webhookRoutes)
app.use('/api/whatsapp', whatsappRoutes)
app.use('/api', registerRoutes)

// 🔐 Rutas protegidas
app.use('/api/products', productRoutes)
app.use('/api/config', configRoutes)
app.use('/api', chatRoutes)
app.use('/api', empresaRoutes)
app.use('/api/templates', messageTemplateRoutes)
app.use(mediaProxyRouter)
app.use("/api/orders", ordersRouter)
app.use("/api/payments", paymentsRouter)

// 🗓️ Agenda (NUEVO)
app.use("/api/estetica/config", esteticaConfigRoutes);
app.use('/api/appointments', appointmentsRoutes)
app.use('/api/appointment-hours', appointmentHoursRoutes)

// 404 JSON final
app.use((req, res) => {
    const url = req.originalUrl.split('?')[0]
    console.log('[404]', req.method, url)
    res.status(404).json({ error: 'Not Found' })
})

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const code = err?.status || 500
    const msg = err?.message || 'Internal Server Error'
    if (code >= 500) console.error('[500]', err)
    res.status(code).json({ error: msg })
})

// 🟢 Iniciar servidor
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
    console.log(`🛰️  Socket.IO path: ${socketPath}`)
})

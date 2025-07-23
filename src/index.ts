import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server } from 'socket.io'

import configRoutes from './routes/config.routes'
import webhookRoutes from './routes/webhook.route'
import chatRoutes from './routes/chat.route'
import authRoutes from './routes/auth.route'

// 📦 Cargar variables de entorno
dotenv.config()

// 🚀 Inicializar servidor Express
const app = express()

// 🧠 Servidor HTTP + WebSocket
const server = http.createServer(app)
const io = new Server(server, {
    cors: {
        origin: '*',
    },
})
app.set('io', io) // 👉 Exportable desde otros módulos si lo necesitas

// 🔌 WebSocket conectado
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket')
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado')
    })
})

// 🌐 Middlewares
app.use(cors({
    origin: ['https://www.wasaaa.com', 'http://localhost:3000'],
    credentials: true, // por si en el futuro usas cookies
}))

app.use(express.urlencoded({ extended: true }))
app.use(express.json({ type: 'application/json', limit: '5mb' }))

// 🌍 Establecer encoding UTF-8 por defecto
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    req.setEncoding('utf8')
    next()
})

// 📌 Rutas públicas
app.use('/api/auth', authRoutes)       // login, registro, OAuth
app.use('/api', webhookRoutes)         // recibe mensajes desde WhatsApp (puede mantenerse pública)

// 🔐 Rutas protegidas (verificarJWT dentro de cada archivo de ruta)
app.use('/api/config', configRoutes)   // configuración del negocio
app.use('/api', chatRoutes)            // historial, estados, respuesta IA


// 🏠 Ruta raíz
app.get('/', (req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente')
})

// 🟢 Iniciar servidor
const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
})

import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import http from "http"
import { Server } from "socket.io"

import configRoutes from './routes/config.routes'
import webhookRoutes from './routes/webhook.route'
import chatRoutes from './routes/chat.route'

dotenv.config()

const app = express()
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ type: 'application/json', limit: '5mb' }));

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    req.setEncoding('utf8'); // Forzar interpretación de entradas como UTF-8
    next();
});


// 🧠 Servidor HTTP
const server = http.createServer(app)

// 🔌 Configuración de WebSocket
const io = new Server(server, {
    cors: {
        origin: '*'
    }
})

// 🔁 Guarda la instancia de io en el objeto app
app.set('io', io)

// 🎧 Cuando se conecta un cliente
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket')

    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado')
    })
})

// Rutas API
app.use("/api/config", configRoutes)
app.use('/api', webhookRoutes)
app.use('/api', chatRoutes)

app.get("/", (req, res) => {
    res.send("🚀 Backend de Chat IA corriendo correctamente")
})

const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`)
})

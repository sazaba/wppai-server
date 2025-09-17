"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const compression_1 = __importDefault(require("compression"));
// Rutas
const config_routes_1 = __importDefault(require("./routes/config.routes"));
const webhook_route_1 = __importDefault(require("./routes/webhook.route"));
const chat_route_1 = __importDefault(require("./routes/chat.route"));
const auth_route_1 = __importDefault(require("./routes/auth.route"));
const whatsapp_routes_1 = __importDefault(require("./routes/whatsapp.routes"));
const empresa_routes_1 = __importDefault(require("./routes/empresa.routes"));
const template_routes_1 = __importDefault(require("./routes/template.routes"));
const product_routes_1 = __importDefault(require("./routes/product.routes"));
const mediaProxy_route_1 = __importDefault(require("./routes/mediaProxy.route"));
const orders_routes_1 = __importDefault(require("./routes/orders.routes"));
const payments_routes_1 = __importDefault(require("./routes/payments.routes"));
const whatsapp_register_routes_1 = __importDefault(require("./routes/whatsapp.register.routes"));
// Agenda 
const appointments_routes_1 = __importDefault(require("./routes/appointments.routes"));
const appointmentHours_routes_1 = __importDefault(require("./routes/appointmentHours.routes"));
// 📦 Cargar variables de entorno
dotenv_1.default.config();
// Normaliza y valida un path (evita valores estilo URL completas)
function sanitizePath(input, fallback = '/socket.io') {
    if (!input)
        return fallback;
    try {
        // Si viene una URL completa (https://...), la rechazamos
        // y usamos el fallback para evitar que algún lib intente registrarla como ruta.
        const u = new URL(input);
        // si no lanza, entonces era URL
        return fallback;
    }
    catch {
        // no era URL; nos aseguramos que empiece por "/"
        return input.startsWith('/') ? input : `/${input}`;
    }
}
// 🌐 Orígenes permitidos
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const allowedOrigins = new Set([
    'https://wppai-client.vercel.app',
    'https://www.wasaaa.com',
    'https://wasaaa.com',
    'http://localhost:3000',
    ...ENV_ALLOWED,
]);
const dynamicAllowed = (origin) => {
    if (!origin)
        return true;
    try {
        const u = new URL(origin);
        if (allowedOrigins.has(origin))
            return true;
        if (u.hostname === 'localhost')
            return true;
        if (u.hostname.endsWith('.vercel.app'))
            return true;
        if (u.hostname.endsWith('.wasaaa.com'))
            return true;
    }
    catch { /* noop */ }
    return false;
};
// 🚀 Inicializar servidor Express
const app = (0, express_1.default)();
// 🧠 Servidor HTTP + WebSocket
const server = http_1.default.createServer(app);
const socketPath = sanitizePath(process.env.SOCKET_IO_PATH, '/socket.io');
const io = new socket_io_1.Server(server, {
    path: socketPath,
    cors: {
        origin: (origin, cb) => {
            if (dynamicAllowed(origin))
                return cb(null, true);
            console.warn('❌ [Socket.IO CORS] Origen no permitido:', origin);
            cb(new Error('Socket.IO CORS blocked'));
        },
        credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
});
app.set('io', io);
// ✅ Confiar en proxy (Render/Cloudflare)
app.set('trust proxy', 1);
// 🔌 WebSocket conectado
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado vía WebSocket');
    socket.on('disconnect', (reason) => {
        console.log('❌ Cliente desconectado:', reason);
    });
});
// 🌐 Middlewares base
app.use((0, compression_1.default)());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (dynamicAllowed(origin))
            return callback(null, true);
        console.warn('❌ [HTTP CORS] Origen no permitido:', origin);
        callback(new Error('No permitido por CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Length'],
}));
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.json({ type: 'application/json', limit: '5mb' }));
// 🏥 Healthchecks
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/readyz', (_req, res) => res.status(200).send('ready'));
// 🏠 Ruta raíz
app.get('/', (_req, res) => {
    res.send('🚀 Backend de Chat IA corriendo correctamente');
});
// 📌 Rutas públicas
app.use('/api/auth', auth_route_1.default);
app.use('/api/webhook', webhook_route_1.default);
app.use('/api/whatsapp', whatsapp_routes_1.default);
app.use('/api', whatsapp_register_routes_1.default);
// 🔐 Rutas protegidas
app.use('/api/products', product_routes_1.default);
app.use('/api/config', config_routes_1.default);
app.use('/api', chat_route_1.default);
app.use('/api', empresa_routes_1.default);
app.use('/api/templates', template_routes_1.default);
app.use(mediaProxy_route_1.default);
app.use("/api/orders", orders_routes_1.default);
app.use("/api/payments", payments_routes_1.default);
// 🗓️ Agenda (NUEVO)
app.use('/api/appointments', appointments_routes_1.default);
app.use('/api/appointment-hours', appointmentHours_routes_1.default);
// 404 JSON final
app.use((req, res) => {
    const url = req.originalUrl.split('?')[0];
    console.log('[404]', req.method, url);
    res.status(404).json({ error: 'Not Found' });
});
// Error handler
app.use((err, _req, res, _next) => {
    const code = err?.status || 500;
    const msg = err?.message || 'Internal Server Error';
    if (code >= 500)
        console.error('[500]', err);
    res.status(code).json({ error: msg });
});
// 🟢 Iniciar servidor
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT}`);
    console.log(`🛰️  Socket.IO path: ${socketPath}`);
});

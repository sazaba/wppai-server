import { Router } from 'express';
import { saveClient, getClients } from '../controllers/client.controller';
import { verificarJWT } from "../middleware/auth.middleware";

const router = Router();

// Middleware de protección aplicado a todas las rutas de /clients
router.use(verificarJWT);

// GET /api/clients - Listar clientes
router.get('/', getClients);

// POST /api/clients - Crear o Actualizar cliente
router.post('/', saveClient);

export default router;
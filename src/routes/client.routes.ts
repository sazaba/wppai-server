import { Router } from 'express';
import { saveClient, getClients, updateClientStatus } from '../controllers/client.controller';
import { verificarJWT } from "../middleware/auth.middleware";

const router = Router();

// Middleware de protección para todas las rutas
router.use(verificarJWT);

// GET /api/clients - Listar todos
router.get('/', getClients);

// POST /api/clients - Crear o Actualizar (Upsert)
router.post('/', saveClient);

// PUT /api/clients/:id - Cambiar estado (Papelera/Restaurar) o editar campos individuales
router.put('/:id', updateClientStatus);

export default router;
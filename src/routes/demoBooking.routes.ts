import { Router } from 'express'
import { 
  createDemoBooking, 
  getDemoBookings, 
  deleteDemoBooking 
} from '../controllers/demoBooking.controller'

const router = Router()

// POST: Crear nueva demo (Público, usado por la landing)
router.post('/', createDemoBooking)

// GET: Ver todas las demos (Deberías proteger esto con autenticación en el futuro)
router.get('/', getDemoBookings)

// DELETE: Borrar una demo por ID
router.delete('/:id', deleteDemoBooking)

export default router
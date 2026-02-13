import { Router } from 'express'
import { 
  createDemoBooking, 
  getDemoBookings, 
  deleteDemoBooking, 
  updateDemoBooking
} from '../controllers/demoBooking.controller'

const router = Router()

// POST: Crear nueva demo (Público, usado por la landing)
router.post('/', createDemoBooking)

// GET: Ver todas las demos
router.get('/', getDemoBookings)

// DELETE: Borrar una demo por ID
router.delete('/:id', deleteDemoBooking)

// PATCH: Actualizar estado (NUEVO)
router.patch('/:id', updateDemoBooking)


export default router
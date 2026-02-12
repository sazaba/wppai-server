import { Router } from 'express'
import { createDemoBooking } from '../controllers/demoBooking.controller'

const router = Router()

// Endpoint: POST /api/demo-booking
router.post('/', createDemoBooking)

export default router
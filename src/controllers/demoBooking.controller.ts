import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export const createDemoBooking = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, date, time } = req.body

    // 1. Validaciones básicas
    if (!name || !email || !phone || !date || !time) {
      return res.status(400).json({ 
        error: 'Faltan campos requeridos (name, email, phone, date, time)' 
      })
    }

    // 2. Fusión de Fecha y Hora (La magia ocurre aquí)
    // El frontend envía date como ISO string y time como "09:00 AM"
    const scheduledDate = new Date(date)
    
    // Parseamos la hora "09:30 AM"
    const [timeStr, modifier] = time.split(' ') // ["09:30", "AM"]
    let [hours, minutes] = timeStr.split(':') // ["09", "30"]
    
    let hoursInt = parseInt(hours)
    
    // Convertir a formato 24h
    if (hoursInt === 12) {
      hoursInt = 0
    }
    if (modifier === 'PM') {
      hoursInt = hoursInt + 12
    }

    // Establecer la hora en el objeto fecha
    scheduledDate.setHours(hoursInt, parseInt(minutes), 0, 0)

    // 3. Guardar en Base de Datos usando tu modelo existente
    const newBooking = await prisma.demoBooking.create({
      data: {
        name,
        email,
        phone,
        scheduledAt: scheduledDate, // Aquí va la fecha combinada
        status: 'pending'
      }
    })

    return res.status(201).json({
      success: true,
      message: 'Demo agendada correctamente',
      data: newBooking
    })

  } catch (error) {
    console.error('Error en createDemoBooking:', error)
    return res.status(500).json({ error: 'Error interno del servidor al agendar' })
  }
}
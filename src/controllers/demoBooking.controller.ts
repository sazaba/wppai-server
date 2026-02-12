import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { Resend } from 'resend'

const prisma = new PrismaClient()
const resend = new Resend(process.env.RESEND_API_KEY)

// --- Función para diseñar y enviar el correo con Resend ---
async function sendConfirmationEmail(toEmail: string, name: string, date: Date, time: string) {
  const formattedDate = date.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 20px; border-radius: 10px;">
      <div style="background-color: #000; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 24px;">Wasaaa<span style="color: #06b6d4;">.</span></h1>
      </div>
      <div style="background-color: #fff; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111; margin-top: 0;">¡Hola ${name}! 👋</h2>
        <p style="color: #4b5563; font-size: 16px; line-height: 1.5;">
          Tu solicitud para la <strong>Auditoría de Crecimiento con IA</strong> ha sido confirmada correctamente.
        </p>
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #06b6d4;">
          <p style="margin: 5px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Fecha</p>
          <p style="margin: 0 0 15px 0; font-size: 18px; color: #111; font-weight: bold;">${formattedDate}</p>
          <p style="margin: 5px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Hora</p>
          <p style="margin: 0; font-size: 18px; color: #111; font-weight: bold;">${time}</p>
        </div>
        <p style="color: #4b5563; font-size: 16px;">
          Un experto de nuestro equipo te contactará por WhatsApp a este número para coordinar el acceso a la videollamada.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} Wasaaa Inc. Transformando clínicas estéticas.
        </p>
      </div>
    </div>
  `

  await resend.emails.send({
    from: 'Wasaaa IA <onboarding@resend.dev>', // Recuerda cambiar esto cuando verifiques dominio
    to: toEmail,
    subject: '✅ Confirmación: Tu Auditoría de IA está lista',
    html: htmlContent,
  })
}

// 1. CREAR (Ya la tenías)
export const createDemoBooking = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, date, time } = req.body

    if (!name || !email || !phone || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos requeridos' })
    }

    const scheduledDate = new Date(date)
    const [timeStr, modifier] = time.split(' ') 
    let [hours, minutes] = timeStr.split(':') 
    let hoursInt = parseInt(hours)
    
    if (hoursInt === 12) hoursInt = 0
    if (modifier === 'PM') hoursInt = hoursInt + 12
    scheduledDate.setHours(hoursInt, parseInt(minutes), 0, 0)

    const newBooking = await prisma.demoBooking.create({
      data: {
        name,
        email,
        phone,
        scheduledAt: scheduledDate,
        status: 'pending'
      }
    })

    try {
      await sendConfirmationEmail(email, name, scheduledDate, time)
    } catch (emailError) {
      console.error('Error enviando correo Resend:', emailError)
    }

    return res.status(201).json({
      success: true,
      message: 'Demo agendada y correo enviado',
      data: newBooking
    })

  } catch (error) {
    console.error('Error en createDemoBooking:', error)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// 2. OBTENER LISTADO (Para tu panel)
export const getDemoBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await prisma.demoBooking.findMany({
      orderBy: {
        createdAt: 'desc' // Las más recientes primero
      }
    })
    return res.status(200).json(bookings)
  } catch (error) {
    console.error('Error obteniendo demos:', error)
    return res.status(500).json({ error: 'Error al obtener el listado' })
  }
}

// 3. ELIMINAR (Para borrar pruebas o spam)
export const deleteDemoBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: 'ID es requerido' })
    }

    await prisma.demoBooking.delete({
      where: {
        id: Number(id)
      }
    })

    return res.status(200).json({ success: true, message: 'Demo eliminada correctamente' })
  } catch (error) {
    console.error('Error eliminando demo:', error)
    return res.status(500).json({ error: 'Error al eliminar la demo' })
  }
}
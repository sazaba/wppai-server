import { Request, Response } from 'express'
import prisma from '../lib/prisma' // ✅ Usamos tu instancia compartida
import { Resend } from 'resend'

// Inicializamos Resend con la key de tus variables de entorno
const resend = new Resend(process.env.RESEND_API_KEY)

// --- Función interna para enviar el correo usando el SDK de Resend ---
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
          © ${new Date().getFullYear()} Wasaaa Inc.
        </p>
      </div>
    </div>
  `

  // ⚠️ IMPORTANTE: Si aún no has verificado tu dominio en Resend,
  // solo puedes enviar a tu propio correo o debes usar 'onboarding@resend.dev' como remitente.
  // Una vez verifiques 'wasaaa.com', cambia el 'from' a 'hola@wasaaa.com'
  
  await resend.emails.send({
    from: 'Wasaaa IA <onboarding@resend.dev>', 
    to: toEmail,
    subject: '✅ Confirmación: Tu Auditoría de IA está lista',
    html: htmlContent,
  })
}

// 1. CREAR BOOKING
export const createDemoBooking = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, date, time } = req.body

    // Validar
    if (!name || !email || !phone || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos requeridos' })
    }

    // Procesar Fecha y Hora
    const scheduledDate = new Date(date)
    const [timeStr, modifier] = time.split(' ') 
    let [hours, minutes] = timeStr.split(':') 
    let hoursInt = parseInt(hours)
    
    if (hoursInt === 12) hoursInt = 0
    if (modifier === 'PM') hoursInt = hoursInt + 12
    scheduledDate.setHours(hoursInt, parseInt(minutes), 0, 0)

    // Guardar en DB
    const newBooking = await prisma.demoBooking.create({
      data: {
        name,
        email,
        phone,
        scheduledAt: scheduledDate,
        status: 'pending'
      }
    })

    // Enviar Correo con Resend SDK
    try {
      await sendConfirmationEmail(email, name, scheduledDate, time)
      console.log(`[DemoBooking] Correo enviado a ${email} vía Resend`)
    } catch (emailError) {
      console.error('[DemoBooking] Error enviando correo Resend:', emailError)
      // No bloqueamos la respuesta al cliente, la cita ya se guardó
    }

    return res.status(201).json({
      success: true,
      message: 'Demo agendada correctamente',
      data: newBooking
    })

  } catch (error) {
    console.error('[createDemoBooking] Error:', error)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// 2. OBTENER TODAS (Dashboard)
export const getDemoBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await prisma.demoBooking.findMany({
      orderBy: { createdAt: 'desc' }
    })
    return res.json(bookings)
  } catch (error) {
    console.error('[getDemoBookings] Error:', error)
    return res.status(500).json({ error: 'Error al obtener citas' })
  }
}

// 3. ELIMINAR (Dashboard)
export const deleteDemoBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'ID requerido' })

    await prisma.demoBooking.delete({
      where: { id: Number(id) }
    })

    return res.json({ success: true, message: 'Eliminado correctamente' })
  } catch (error) {
    console.error('[deleteDemoBooking] Error:', error)
    return res.status(500).json({ error: 'Error al eliminar' })
  }
}
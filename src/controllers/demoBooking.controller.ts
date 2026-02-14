import { Request, Response } from 'express'
import prisma from '../lib/prisma' 
import { Resend } from 'resend'

// --- CONFIGURACIÓN ---
const resend = new Resend(process.env.RESEND_API_KEY)
const GOOGLE_MEET_LINK = "https://meet.google.com/usn-pmjp-mxw"
const MY_EMAIL = "wasaaa2026@gmail.com" // <--- 🔔 PON TU CORREO AQUÍ

// 1. CORREO PARA EL CLIENTE (Confirmación)
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
          Tu auditoría ha sido agendada. Aquí tienes los detalles de conexión:
        </p>
        
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #06b6d4;">
          <p style="margin: 5px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Cuándo</p>
          <p style="margin: 0 0 15px 0; font-size: 18px; color: #111; font-weight: bold;">${formattedDate} - ${time}</p>
          
          <p style="margin: 5px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Dónde</p>
          <p style="margin: 0;">
            <a href="${GOOGLE_MEET_LINK}" style="background-color: #06b6d4; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; font-size: 14px; display: inline-block;">
              Unirse a Google Meet 📹
            </a>
          </p>
        </div>

        <p style="color: #6b7280; font-size: 14px;">
          Te recomendamos conectarte 2 minutos antes.
        </p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} Wasaaa Inc.
        </p>
      </div>
    </div>
  `

  await resend.emails.send({
    from: 'Wasaaa IA <hola@wasaaa.com>',
    to: [toEmail],
    subject: '✅ Confirmación y Link de Acceso: Auditoría IA',
    html: htmlContent,
  })
}

// 2. CORREO PARA TI (Alerta de Nuevo Lead) - NUEVA FUNCIÓN
async function sendAdminAlert(data: { name: string, email: string, phone: string, date: Date, time: string }) {
    const formattedDate = data.date.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })
    
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #fff3cd; border: 1px solid #ffeeba; color: #856404; border-radius: 8px;">
        <h2 style="margin-top: 0;">🚀 ¡Nuevo Prospecto Agendado!</h2>
        <p>Alguien acaba de agendar una demo desde la web.</p>
        
        <ul style="background-color: #fff; padding: 15px 30px; border-radius: 5px; border: 1px solid #e2e3e5; color: #333;">
            <li><strong>Nombre:</strong> ${data.name}</li>
            <li><strong>Email:</strong> ${data.email}</li>
            <li><strong>Teléfono:</strong> ${data.phone}</li>
            <li><strong>Fecha:</strong> ${formattedDate}</li>
            <li><strong>Hora:</strong> ${data.time}</li>
        </ul>

        <p style="margin-bottom: 0;">Prepara la reunión. ¡A vender!</p>
      </div>
    `
  
    await resend.emails.send({
      from: 'Wasaaa Alertas <alertas@wasaaa.com>', // Puedes usar el mismo 'hola@' si prefieres
      to: [MY_EMAIL],
      subject: `🤑 Nuevo Lead: ${data.name}`,
      html: htmlContent,
    })
  }

// --- CONTROLLERS ---

export const createDemoBooking = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, date, time } = req.body

    if (!name || !email || !phone || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos requeridos' })
    }

    // Procesar fecha y hora
    const scheduledDate = new Date(date)
    const [timeStr, modifier] = time.split(' ') 
    let [hours, minutes] = timeStr.split(':') 
    let hoursInt = parseInt(hours)
    
    if (hoursInt === 12) hoursInt = 0
    if (modifier === 'PM') hoursInt = hoursInt + 12
    scheduledDate.setHours(hoursInt, parseInt(minutes), 0, 0)

    // --- 🔒 BLOQUEO: Verificar si ya existe ---
    const existing = await prisma.demoBooking.findFirst({
      where: {
        scheduledAt: scheduledDate
      }
    })

    if (existing) {
      return res.status(409).json({ error: 'Este horario ya no está disponible. Por favor elige otro.' })
    }

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

    // --- ENVIAR CORREOS (En paralelo para no bloquear) ---
    try {
      await Promise.all([
        // 1. Correo al Cliente
        sendConfirmationEmail(email, name, scheduledDate, time),
        // 2. Correo a TI (Admin)
        sendAdminAlert({ name, email, phone, date: scheduledDate, time })
      ])
      
      console.log(`📧 Emails enviados (Cliente y Admin)`)
    } catch (emailError) {
      console.error('⚠️ Error enviando emails:', emailError)
      // No fallamos la request si el email falla, pero lo logueamos
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

// 2. GET (Listar)
export const getDemoBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await prisma.demoBooking.findMany({
      orderBy: { createdAt: 'desc' }
    })
    return res.json(bookings)
  } catch (error) {
    return res.status(500).json({ error: 'Error al obtener citas' })
  }
}

// 3. DELETE (Eliminar)
export const deleteDemoBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'ID requerido' })

    await prisma.demoBooking.delete({ where: { id: Number(id) } })
    return res.json({ success: true })
  } catch (error) {
    return res.status(500).json({ error: 'Error al eliminar' })
  }
}

// 4. UPDATE (Actualizar estado)
export const updateDemoBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { status } = req.body 

    if (!id || !status) {
      return res.status(400).json({ error: 'Faltan datos' })
    }

    const updatedBooking = await prisma.demoBooking.update({
      where: { id: Number(id) },
      data: { status }
    })

    return res.json({ success: true, data: updatedBooking })
  } catch (error) {
    console.error('Error actualizando booking:', error)
    return res.status(500).json({ error: 'No se pudo actualizar' })
  }
}
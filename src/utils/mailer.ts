// src/utils/mailer.ts
import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465, 
  secure: true, // true para puerto 465, false para 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

export const enviarCorreoVerificacion = async (email: string, token: string) => {
  // Asegúrate de que FRONTEND_URL esté definido en Render
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  const url = `${frontendUrl}/activar-cuenta?token=${token}`

  console.log(`[Mailer] Preparando correo para ${email}...`)

  try {
    const info = await transporter.sendMail({
      from: '"Wasaaa Soporte" <no-reply@wasaaa.com>',
      to: email,
      subject: 'Activa tu cuenta en Wasaaa 🚀',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background-color: #f4f4f5; border-radius: 10px;">
          <h2 style="color: #4F46E5; text-align: center;">¡Bienvenido a Wasaaa!</h2>
          <p style="color: #333; font-size: 16px;">Hola,</p>
          <p style="color: #555; line-height: 1.5;">Gracias por registrarte. Para comenzar a automatizar tu negocio y recibir las instrucciones de uso, por favor confirma que este es tu correo electrónico.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${url}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Activar mi Cuenta</a>
          </div>

          <p style="color: #777; font-size: 12px; text-align: center;">Si no creaste esta cuenta, ignora este mensaje.</p>
        </div>
      `,
    })
    console.log('[Mailer] Correo enviado ID:', info.messageId)
  } catch (error) {
    console.error('[Mailer] Error FATAL enviando correo:', error)
    // Aquí solo logueamos porque la función se llama sin await
    throw error
  }
}
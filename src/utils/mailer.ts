// wppai-server/src/utils/mailer.ts
import nodemailer from 'nodemailer'

// Configuración del transporte (SMTP)
// Asegúrate de tener estas variables en tu archivo .env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true, // true para puerto 465, false para otros (587)
  auth: {
    user: process.env.SMTP_USER, // Tu correo
    pass: process.env.SMTP_PASS, // Tu contraseña de aplicación (App Password)
  },
})

export const enviarCorreoVerificacion = async (email: string, token: string) => {
  // Ajusta la URL para que apunte a tu Frontend
  // Si estás en desarrollo local suele ser http://localhost:3000
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  const url = `${frontendUrl}/activar-cuenta?token=${token}`

  console.log(`[Mailer] Enviando correo a ${email} con link: ${url}`)

  try {
    await transporter.sendMail({
      from: '"Soporte Wasaaa 👻" <no-reply@wasaaa.com>',
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

          <p style="color: #777; font-size: 12px; text-align: center;">Si no creaste esta cuenta, puedes ignorar este mensaje.</p>
        </div>
      `,
    })
    console.log('[Mailer] Correo enviado exitosamente')
  } catch (error) {
    console.error('[Mailer] Error enviando correo:', error)
    // No lanzamos el error para no romper el registro si falla el correo,
    // pero idealmente deberías manejarlo.
  }
}
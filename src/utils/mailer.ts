// src/utils/mailer.ts
import { Resend } from 'resend'

// Inicializamos Resend con la clave de entorno
const resend = new Resend(process.env.RESEND_API_KEY)

// 1. CORREO DE VERIFICACIÓN (Registro)
export const enviarCorreoVerificacion = async (email: string, token: string) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  const url = `${frontendUrl}/activar-cuenta?token=${token}`

  console.log(`[Resend] Enviando correo de activación a ${email}...`)

  try {
    const data = await resend.emails.send({
      from: 'Soporte Wasaaa <soporte@wasaaa.com>',
      to: [email],
      subject: 'Activa tu cuenta en Wasaaa 🚀',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background-color: #f4f4f5; border-radius: 10px;">
          <h2 style="color: #4F46E5; text-align: center;">¡Bienvenido a Wasaaa!</h2>
          <p style="color: #333; font-size: 16px;">Hola,</p>
          <p style="color: #555; line-height: 1.5;">Gracias por registrarte. Para comenzar a automatizar tu negocio, confirma tu correo:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${url}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Activar mi Cuenta</a>
          </div>
          
          <p style="color: #777; font-size: 12px; text-align: center;">Si no creaste esta cuenta, ignora este mensaje.</p>
        </div>
      `,
    })

    if (data.error) {
      console.error('[Resend] Error devuelto por la API:', data.error)
    } else {
      console.log('[Resend] Correo de activación enviado ID:', data.data?.id)
    }
  } catch (error) {
    console.error('[Resend] Error de conexión:', error)
  }
}

// 2. CORREO DE RECUPERACIÓN (Olvide mi contraseña)
export const enviarCorreoRecuperacion = async (email: string, token: string) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  const url = `${frontendUrl}/reset-password?token=${token}`

  console.log(`[Resend] Enviando correo de recuperación a ${email}...`)

  try {
    const data = await resend.emails.send({
      from: 'Soporte Wasaaa <soporte@wasaaa.com>',
      to: [email],
      subject: 'Recupera tu contraseña de Wasaaa 🔐',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background-color: #f4f4f5; border-radius: 10px;">
          <h2 style="color: #4F46E5; text-align: center;">Recuperación de Contraseña</h2>
          <p style="color: #333; font-size: 16px;">Hola,</p>
          <p style="color: #555; line-height: 1.5;">Hemos recibido una solicitud para restablecer tu contraseña. Si fuiste tú, haz clic en el botón de abajo:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${url}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Restablecer Contraseña</a>
          </div>
          
          <p style="color: #777; font-size: 12px; text-align: center;">Este enlace expirará en 1 hora.</p>
          <p style="color: #777; font-size: 12px; text-align: center;">Si no solicitaste esto, puedes ignorar este correo tranquilamente.</p>
        </div>
      `,
    })

    if (data.error) {
      console.error('[Resend] Error devuelto por la API:', data.error)
    } else {
      console.log('[Resend] Correo de recuperación enviado ID:', data.data?.id)
    }
  } catch (error) {
    console.error('[Resend] Error de conexión:', error)
  }
}
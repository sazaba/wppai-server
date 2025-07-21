// src/utils/sendWhatsappMessage.ts
import axios from 'axios'

export const sendWhatsappMessage = async (to: string, message: string) => {
    try {
        const token = process.env.WHATSAPP_TEMP_TOKEN
        const phoneNumberId = process.env.WHATSAPP_PHONE_ID

        const payload = {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: message }
        }

        const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        })

        console.log('✅ Mensaje enviado a WhatsApp:', response.data)
    } catch (error: any) {
        console.error('❌ Error al enviar mensaje a WhatsApp:', error.response?.data || error.message)
    }
}

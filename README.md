# wppai-server


access_token: EAAVMT7pLbJgBPPieHZAXUbFJaq5KlalTnidEVW1MVZCucro8g31TuOM9F0zD1Pv4jyXgRJm5sFlmZCGSznQsWBINYZC7tQibZCW1pkuo1SbDq2DjkISUwstx9C307sp3vLWWTMZCESudMVlnPhdHVE3djNzNNZBxTCMiueU22SxKvEBfkTWy1yizASgqMh4tO7yXaJTihRnVasGHRgekw3PaxQcPkrJGcq3c1cHvZA3w3mjboDUqs0e5bs3qiyEZD

business_id: 1822989931897291

phone_number_id: 726603760533018




🔜 PENDIENTE POR HACER
1. 🧠 Guardar cuenta de WhatsApp cuando se vincula vía OAuth
 Extraer phone_number_id y access_token en /auth/callback

 Guardarlos en la tabla WhatsappAccount con relación a la empresa autenticada

2. 🛎 Usar phone_number_id en el webhook
 En receiveWhatsappMessage, extraer entry[0].id como phoneNumberId

 Buscar la empresa correcta usando:

ts
Copiar
Editar
const cuenta = await prisma.whatsappAccount.findUnique({ where: { phoneNumberId } })
 Crear conversación con empresaId correcto desde esa cuenta

3. 🎯 Seguridad y escalabilidad
 Validar roles (admin, agente, invitado) en middleware según la ruta

 Implementar panel para gestión de usuarios por empresa

4. 💬 Frontend (si no está hecho aún)
 Iniciar sesión y guardar token

 Filtrar chats, configs, mensajes por empresa autenticada

 Mostrar botón para crear conversación manual
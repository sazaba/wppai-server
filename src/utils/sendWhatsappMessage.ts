// server/src/utils/sendWhatsappMessage.ts
// ✅ ÚNICA FUENTE DE VERDAD: reexporta todo desde services/whatsapp.service
// Evita tener dos implementaciones distintas y problemas de versiones/envs.

export {
    // Texto (alias clásico esperado por tu código)
    sendWhatsappMessage,     // alias de sendText dentro del service

    // Media
    sendWhatsappMedia,
    sendWhatsappMediaById,
    sendImageByLink,
    sendVideoByLink,
    sendVoiceNoteByLink,
    uploadToWhatsappMedia,

    // Plantillas y facade
    sendTemplate,
    sendOutboundMessage,

    // Media helpers inbound (descarga/URL firmada por Meta)
    getMediaUrl,
    downloadMediaToBuffer,
} from '../services/whatsapp.service'

// (Opcional) reexporta tipos si algún archivo los importa desde utils
export type { MediaType, OutboundResult } from '../services/whatsapp.service'

"use strict";
// server/src/utils/sendWhatsappMessage.ts
// ✅ ÚNICA FUENTE DE VERDAD: reexporta todo desde services/whatsapp.service
// Evita tener dos implementaciones distintas y problemas de versiones/envs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadMediaToBuffer = exports.getMediaUrl = exports.sendOutboundMessage = exports.sendTemplate = exports.uploadToWhatsappMedia = exports.sendVoiceNoteByLink = exports.sendVideoByLink = exports.sendImageByLink = exports.sendWhatsappMediaById = exports.sendWhatsappMedia = exports.sendWhatsappMessage = void 0;
var whatsapp_service_1 = require("../services/whatsapp.service");
// Texto (alias clásico esperado por tu código)
Object.defineProperty(exports, "sendWhatsappMessage", { enumerable: true, get: function () { return whatsapp_service_1.sendWhatsappMessage; } });
// Media
Object.defineProperty(exports, "sendWhatsappMedia", { enumerable: true, get: function () { return whatsapp_service_1.sendWhatsappMedia; } });
Object.defineProperty(exports, "sendWhatsappMediaById", { enumerable: true, get: function () { return whatsapp_service_1.sendWhatsappMediaById; } });
Object.defineProperty(exports, "sendImageByLink", { enumerable: true, get: function () { return whatsapp_service_1.sendImageByLink; } });
Object.defineProperty(exports, "sendVideoByLink", { enumerable: true, get: function () { return whatsapp_service_1.sendVideoByLink; } });
Object.defineProperty(exports, "sendVoiceNoteByLink", { enumerable: true, get: function () { return whatsapp_service_1.sendVoiceNoteByLink; } });
Object.defineProperty(exports, "uploadToWhatsappMedia", { enumerable: true, get: function () { return whatsapp_service_1.uploadToWhatsappMedia; } });
// Plantillas y facade
Object.defineProperty(exports, "sendTemplate", { enumerable: true, get: function () { return whatsapp_service_1.sendTemplate; } });
Object.defineProperty(exports, "sendOutboundMessage", { enumerable: true, get: function () { return whatsapp_service_1.sendOutboundMessage; } });
// Media helpers inbound (descarga/URL firmada por Meta)
Object.defineProperty(exports, "getMediaUrl", { enumerable: true, get: function () { return whatsapp_service_1.getMediaUrl; } });
Object.defineProperty(exports, "downloadMediaToBuffer", { enumerable: true, get: function () { return whatsapp_service_1.downloadMediaToBuffer; } });

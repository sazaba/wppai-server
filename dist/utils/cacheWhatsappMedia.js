"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheWhatsappMediaToCloudflare = cacheWhatsappMediaToCloudflare;
exports.setFocus = setFocus;
exports.getFocus = getFocus;
exports.clearFocus = clearFocus;
// server/src/utils/cacheWhatsappMedia.ts
const axios_1 = __importDefault(require("axios"));
const cloudflareImages_1 = require("../lib/cloudflareImages");
const CF_VARIANT = process.env.CF_IMAGES_VARIANT || "public";
/**
 * Descarga un media de WhatsApp Graph y lo sube a Cloudflare Images.
 * Devuelve { url, imageId, mimeType } para guardar en message.
 */
async function cacheWhatsappMediaToCloudflare({ waMediaId, accessToken, }) {
    // 1) Obtener URL temporal del media en Graph
    const meta = await axios_1.default.get(`https://graph.facebook.com/v19.0/${waMediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const href = meta?.data?.url;
    const mimeType = meta?.data?.mime_type;
    if (!href)
        throw new Error("No media URL from Graph");
    // 2) Descargar binario
    const bin = await axios_1.default.get(href, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${accessToken}` },
        maxBodyLength: Infinity,
    });
    const buffer = Buffer.from(bin.data);
    const filename = `${waMediaId}.bin`;
    // 3) Subir a Cloudflare Images
    const result = await (0, cloudflareImages_1.cfImagesUpload)(buffer, filename);
    // 4) URL final con variant
    const url = (0, cloudflareImages_1.cfImageUrl)(result.id, CF_VARIANT);
    return { url, imageId: result.id, mimeType };
}
const focusMem = new Map();
const FOCUS_TTL_MS = Number(process.env.FOCUS_TTL_MS) || 1000 * 60 * 60 * 6; // 6h
/** Guarda el producto “en foco” de una conversación. */
function setFocus(conversationId, productId) {
    focusMem.set(conversationId, { productId, at: Date.now() });
}
/** Obtiene el producto “en foco” (o null si expiró/no existe). */
function getFocus(conversationId) {
    const v = focusMem.get(conversationId);
    if (!v)
        return null;
    if (Date.now() - v.at > FOCUS_TTL_MS) {
        focusMem.delete(conversationId);
        return null;
    }
    return v.productId;
}
/** Borra el foco manualmente (p.ej., al cerrar conversación). */
function clearFocus(conversationId) {
    focusMem.delete(conversationId);
}

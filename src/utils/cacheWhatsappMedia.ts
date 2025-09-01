// server/src/utils/cacheWhatsappMedia.ts
import axios from "axios";
import { cfImagesUpload, cfImageUrl } from "../lib/cloudflareImages";

const CF_VARIANT = process.env.CF_IMAGES_VARIANT || "public";

/**
 * Descarga un media de WhatsApp Graph y lo sube a Cloudflare Images.
 * Devuelve { url, imageId, mimeType } para guardar en message.
 */
export async function cacheWhatsappMediaToCloudflare({
    waMediaId,
    accessToken,
}: {
    waMediaId: string;
    accessToken: string;
}): Promise<{ url: string; imageId: string; mimeType?: string }> {
    // 1) Obtener URL temporal del media en Graph
    const meta = await axios.get(`https://graph.facebook.com/v19.0/${waMediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const href: string = meta?.data?.url;
    const mimeType: string | undefined = meta?.data?.mime_type;
    if (!href) throw new Error("No media URL from Graph");

    // 2) Descargar binario
    const bin = await axios.get(href, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${accessToken}` },
        maxBodyLength: Infinity,
    });
    const buffer = Buffer.from(bin.data);
    const filename = `${waMediaId}.bin`;

    // 3) Subir a Cloudflare Images
    const result = await cfImagesUpload(buffer, filename);

    // 4) URL final con variant
    const url = cfImageUrl(result.id, CF_VARIANT);
    return { url, imageId: result.id, mimeType };
}

/* ------------------------------------------------------------------
   👇 Cache en memoria para “producto en foco” por conversación (Ruta A)
   - No requiere cambios en la base de datos.
   - Para producción multi-instancia, reemplazar por Redis.
------------------------------------------------------------------- */

type Focus = { productId: number; at: number };
const focusMem = new Map<number, Focus>();
const FOCUS_TTL_MS =
    Number(process.env.FOCUS_TTL_MS) || 1000 * 60 * 60 * 6; // 6h

/** Guarda el producto “en foco” de una conversación. */
export function setFocus(conversationId: number, productId: number) {
    focusMem.set(conversationId, { productId, at: Date.now() });
}

/** Obtiene el producto “en foco” (o null si expiró/no existe). */
export function getFocus(conversationId: number): number | null {
    const v = focusMem.get(conversationId);
    if (!v) return null;
    if (Date.now() - v.at > FOCUS_TTL_MS) {
        focusMem.delete(conversationId);
        return null;
    }
    return v.productId;
}

/** Borra el foco manualmente (p.ej., al cerrar conversación). */
export function clearFocus(conversationId: number) {
    focusMem.delete(conversationId);
}

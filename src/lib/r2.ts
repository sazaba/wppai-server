// server/src/lib/r2.ts
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL,   // opcional: solo para URL públicas de lectura
} = process.env;

if (!R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    throw new Error("[R2] Faltan variables: R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID.");
}

/**
 * MUY IMPORTANTE:
 * - Endpoint SIEMPRE de cuenta: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   (NO usar aquí el host público del bucket)
 */
const ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// Cliente S3 simple (sin agentes ni prechecks)
export const r2 = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true, // recomendado en R2
});

export const R2_BUCKET_NAME = R2_BUCKET!;

// ------- helpers públicos (solo lectura) -------
export const R2_PUBLIC_BASE = (R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

export function publicR2Url(key: string) {
    if (!R2_PUBLIC_BASE) {
        throw new Error("[R2] Falta R2_PUBLIC_BASE_URL para construir URL pública.");
    }
    return `${R2_PUBLIC_BASE}/${key.replace(/^\/+/, "")}`;
}

// Genera key para imágenes de producto
export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase().replace(/[^\w]+/g, "");
    return `products/${productId}/${randomUUID()}.${ext || "bin"}`;
}

// --- SUBIR ---
export async function r2PutObject(objectKey: string, body: Buffer, contentType?: string) {
    const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: contentType || "application/octet-stream",
    });
    await r2.send(cmd);
    return publicR2Url(objectKey);
}

// --- BORRAR ---
export async function r2DeleteObject(objectKey: string) {
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey });
    await r2.send(cmd);
}

// --- URL firmada (GET) ---
export async function getSignedGetUrl(key: string, expiresSec = 3600) {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
    return getSignedUrl(r2, cmd, { expiresIn: expiresSec });
}

// Elegir pública vs firmada según prefieras (si tu bucket es público, usa pública)
export async function resolveR2Url(key: string, opts?: { expiresSec?: number }) {
    if (process.env.R2_SIGNED_GET === "1") {
        return getSignedGetUrl(key, opts?.expiresSec ?? 3600);
    }
    return publicR2Url(key);
}

// re-export útil
export { GetObjectCommand };

export async function getSignedPutUrl(key: string, contentType = "application/octet-stream", expiresSec = 300) {
    const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: contentType,
    })
    return getSignedUrl(r2, cmd, { expiresIn: expiresSec })
}
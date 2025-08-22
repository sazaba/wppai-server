// src/lib/r2.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "https";
import { randomUUID } from "crypto";

const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("[R2] Faltan variables de entorno (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).");
}

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// 👇 Agente HTTPS que fuerza TLS >= 1.2 (algunas plataformas fallan con negociaciones por defecto)
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    // Render/Node a veces negocia mal TLS1.3 con R2 → forzamos mínimo 1.2 (que R2 soporta)
    minVersion: "TLSv1.2",
});

export const r2 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    forcePathStyle: true, // importante para R2
    requestHandler: new NodeHttpHandler({ httpsAgent }),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
});

export const R2_BUCKET_NAME = R2_BUCKET!;
export const R2_PUBLIC_BASE = R2_PUBLIC_BASE_URL || `${R2_ENDPOINT}/${R2_BUCKET_NAME}`;

export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase();
    return `products/${productId}/${randomUUID()}.${ext}`;
}

export async function r2PutObject(objectKey: string, body: Buffer, contentType?: string) {
    const cmd = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: contentType || "application/octet-stream",
    });
    await r2.send(cmd);
    return `${R2_PUBLIC_BASE}/${objectKey}`;
}

export async function r2DeleteObject(objectKey: string) {
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey });
    await r2.send(cmd);
}

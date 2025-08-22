// src/lib/r2.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "https";
import { randomUUID } from "crypto";
import http from "http";
import { URL } from "url";

const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL,
    R2_ENDPOINT, // opcional
} = process.env;

if (!R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("[R2] Faltan variables: R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
}
if (!R2_ENDPOINT && !R2_ACCOUNT_ID) {
    throw new Error("[R2] Faltan variables: R2_ENDPOINT o R2_ACCOUNT_ID.");
}

const ENDPOINT = (R2_ENDPOINT && R2_ENDPOINT.trim())
    ? R2_ENDPOINT.trim().replace(/\/+$/, '')
    : `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
});

export const r2 = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ httpsAgent }),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
});

// URLs para devolver al cliente
export const R2_BUCKET_NAME = R2_BUCKET!;
export const R2_PUBLIC_BASE = (R2_PUBLIC_BASE_URL && R2_PUBLIC_BASE_URL.trim())
    ? R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, '')
    : `${ENDPOINT}/${R2_BUCKET_NAME}`;

export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase();
    return `products/${productId}/${randomUUID()}.${ext}`;
}

// ——— PRECHECK TLS: HEAD a la raíz del endpoint ———
async function precheckTLS(endpoint: string) {
    try {
        const u = new URL(endpoint);
        await new Promise<void>((resolve, reject) => {
            const req = https.request(
                { method: "HEAD", hostname: u.hostname, path: "/", agent: httpsAgent },
                res => { res.resume(); resolve(); }
            );
            req.on("error", reject);
            req.end();
        });
    } catch (e: any) {
        console.error("[R2 TLS precheck] fallo handshake:", e?.message || e);
        throw new Error("[R2] Handshake TLS falló contra endpoint. Revisa endpoint, keys y Node.");
    }
}

export async function r2PutObject(objectKey: string, body: Buffer, contentType?: string) {
    await precheckTLS(ENDPOINT); // ayuda a exponer el error real (handshake)
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
    await precheckTLS(ENDPOINT);
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey });
    await r2.send(cmd);
}

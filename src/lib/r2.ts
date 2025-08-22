// src/lib/r2.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "node:https";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

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

// Normaliza endpoint (sin barras finales) y asegura https
const RAW_ENDPOINT = (R2_ENDPOINT && R2_ENDPOINT.trim())
    ? R2_ENDPOINT.trim().replace(/\/+$/, "")
    : `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const ENDPOINT = RAW_ENDPOINT.startsWith("http") ? RAW_ENDPOINT : `https://${RAW_ENDPOINT}`;

// 👇 lookup forzado a IPv4 (evita rutas IPv6 problemáticas en algunos PaaS)
const lookupIPv4: LookupFunction = (hostname: string, options: any, callback?: any) => {
    if (typeof options === "function") {
        // lookup(hostname, callback)
        return dns.lookup(hostname, { family: 4, all: false }, options);
    }
    // lookup(hostname, options, callback)
    return dns.lookup(hostname, { family: 4, all: false }, callback);
};

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
    lookup: lookupIPv4,
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
    ? R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
    : `${ENDPOINT}/${R2_BUCKET_NAME}`;

// Genera key para imágenes de producto
export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase().replace(/[^\w]+/g, "");
    return `products/${productId}/${randomUUID()}.${ext || "bin"}`;
}

// ——— PRECHECK TLS: HEAD al host (fuerza IPv4 y SNI explícito) ———
async function precheckTLS(endpoint: string) {
    const u = new URL(endpoint);
    await new Promise<void>((resolve, reject) => {
        const req = https.request(
            {
                method: "HEAD",
                hostname: u.hostname,
                path: "/",
                agent: httpsAgent,
                servername: u.hostname, // SNI explícito
            },
            (res) => {
                res.resume();
                resolve();
            }
        );
        req.on("error", (err) => {
            console.error("[R2 TLS precheck] fallo handshake:", err?.message || err);
            reject(new Error("[R2] Handshake TLS falló contra endpoint. Revisa endpoint, keys y Node."));
        });
        req.end();
    });
}

export async function r2PutObject(objectKey: string, body: Buffer, contentType?: string) {
    await precheckTLS(ENDPOINT);
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

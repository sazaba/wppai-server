// src/lib/r2.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "node:https";
import tls from "node:tls";
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
    SKIP_R2_TLS_PRECHECK, // opcional: "1" para saltar precheck
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

// lookup forzado a IPv4
const lookupIPv4: LookupFunction = (hostname: string, options: any, callback?: any) => {
    if (typeof options === "function") {
        return dns.lookup(hostname, { family: 4, all: false }, options);
    }
    return dns.lookup(hostname, { family: 4, all: false }, callback);
};

// Agent HTTPS: IPv4 + TLS1.2-only
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    honorCipherOrder: true,
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

// ——— PRECHECK TLS con tls.connect (hostname + SNI + IPv4 + TLS1.2) ———
async function precheckTLS(endpoint: string) {
    const u = new URL(endpoint);
    const port = Number(u.port || 443);

    await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
            {
                host: u.hostname,          // usamos hostname (no IP directa)
                port,
                servername: u.hostname,    // SNI correcto
                minVersion: "TLSv1.2",
                maxVersion: "TLSv1.2",     // fuerza TLS1.2
                rejectUnauthorized: true,
                lookup: lookupIPv4,        // fuerza IPv4
            },
            () => {
                // const proto = socket.alpnProtocol || "unknown";
                // console.log(`[R2 TLS precheck] OK, ALPN: ${proto}`);
                socket.end();
                resolve();
            }
        );

        socket.on("error", (err) => {
            console.error("[R2 TLS precheck] fallo handshake:", err?.message || err);
            reject(new Error("[R2] Handshake TLS falló contra endpoint. Revisa endpoint, keys y Node."));
        });
    });
}

export async function r2PutObject(objectKey: string, body: Buffer, contentType?: string) {
    if (SKIP_R2_TLS_PRECHECK !== "1") {
        await precheckTLS(ENDPOINT);
    }
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
    if (SKIP_R2_TLS_PRECHECK !== "1") {
        await precheckTLS(ENDPOINT);
    }
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey });
    await r2.send(cmd);
}

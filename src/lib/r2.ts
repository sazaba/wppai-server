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
} = process.env;

if (!R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("[R2] Faltan variables: R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
}
if (!R2_ENDPOINT && !R2_ACCOUNT_ID) {
    throw new Error("[R2] Faltan variables: R2_ENDPOINT o R2_ACCOUNT_ID.");
}

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

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
    // 👇 fuerza IPv4 + ALPN HTTP/1.1
    lookup: lookupIPv4,
    ALPNProtocols: ["http/1.1"],
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

export const R2_BUCKET_NAME = R2_BUCKET!;
export const R2_PUBLIC_BASE = (R2_PUBLIC_BASE_URL && R2_PUBLIC_BASE_URL.trim())
    ? R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
    : `${ENDPOINT}/${R2_BUCKET_NAME}`;

export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase().replace(/[^\w]+/g, "");
    return `products/${productId}/${randomUUID()}.${ext || "bin"}`;
}

// ——— PRECHECK TLS con tls.connect (IPv4, SNI, ALPN) ———
async function precheckTLS(endpoint: string) {
    const u = new URL(endpoint);
    const port = Number(u.port || 443);
    // Resolvemos a IPv4 explícito
    const { address } = await new Promise<{ address: string }>((resolve, reject) => {
        dns.lookup(u.hostname, { family: 4, all: false }, (err, address) => {
            if (err) return reject(err);
            resolve({ address });
        });
    });

    await new Promise<void>((resolve, reject) => {
        const socket = tls.connect({
            host: address,          // conectamos al IPv4 directo
            port,
            servername: u.hostname, // SNI correcto (muy importante)
            minVersion: "TLSv1.2",
            ALPNProtocols: ["http/1.1"], // fuerza http/1.1
            rejectUnauthorized: true,
        }, () => {
            // opcional: puedes loguear para diagnóstico
            const proto = socket.alpnProtocol || "unknown";
            // console.log(`[R2 TLS precheck] conectado, ALPN: ${proto}`);
            socket.end(); // cerramos, solo queríamos el handshake
            resolve();
        });

        socket.on("error", (err) => {
            console.error("[R2 TLS precheck] fallo handshake:", err?.message || err);
            reject(new Error("[R2] Handshake TLS falló contra endpoint. Revisa endpoint, keys y Node."));
        });
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

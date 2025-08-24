// server/src/lib/r2.ts
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
    R2_PUBLIC_BASE_URL,   // base pública opcional
    R2_ENDPOINT,          // opcional
    SKIP_R2_TLS_PRECHECK, // opcional
    R2_SIGNED_GET,        // "1" => preferir URL firmada en resolveR2Url
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

const lookupIPv4: LookupFunction = (hostname: string, options: any, callback?: any) => {
    if (!hostname || typeof hostname !== "string") {
        const err = new Error("lookupIPv4: hostname inválido");
        if (typeof options === "function") return options(err);
        return callback?.(err);
    }
    if (typeof options === "function") {
        return dns.lookup(hostname, { family: 4, all: false }, options);
    }
    return dns.lookup(hostname, { family: 4, all: false }, callback);
};

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    honorCipherOrder: true,
});

// Cliente path-style para PUT/DELETE/GET directos (R2)
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

// Cliente vhost-style SOLO para presign GET (evita 401/403 con algunas CDNs)
const r2Vhost = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: false, // virtual-hosted-style
    requestHandler: new NodeHttpHandler({ httpsAgent }),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
});

export const R2_BUCKET_NAME = R2_BUCKET!;

// ---- Base pública (para bucket público) ----
const RAW_PUBLIC_BASE = (R2_PUBLIC_BASE_URL && R2_PUBLIC_BASE_URL.trim())
    ? R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
    : "";

function normalizePublicBase(raw: string, bucket: string) {
    if (!raw) return "";
    try {
        const u = new URL(raw);
        if (u.pathname && new RegExp(`/(^|)${bucket}(/|$)`).test(u.pathname)) {
            return raw.replace(/\/+$/, "");
        }
        return `${raw.replace(/\/+$/, "")}/${bucket}`;
    } catch {
        return `${raw.replace(/\/+$/, "")}/${bucket}`;
    }
}

export const R2_PUBLIC_BASE = RAW_PUBLIC_BASE
    ? normalizePublicBase(RAW_PUBLIC_BASE, R2_BUCKET_NAME)
    : "";

// helper pública (bucket público)
export function publicR2Url(key: string) {
    if (!R2_PUBLIC_BASE) throw new Error("[R2] Falta R2_PUBLIC_BASE_URL (o no incluye el bucket).");
    return `${R2_PUBLIC_BASE}/${key.replace(/^\/+/, "")}`;
}

// Genera key para imágenes de producto
export function makeObjectKeyForProduct(productId: number, originalName: string) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase().replace(/[^\w]+/g, "");
    return `products/${productId}/${randomUUID()}.${ext || "bin"}`;
}

// ——— PRECHECK TLS ———
async function precheckTLS(endpoint: string) {
    const u = new URL(endpoint);
    const port = Number(u.port || 443);
    await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
            {
                host: u.hostname,
                port,
                servername: u.hostname,
                minVersion: "TLSv1.2",
                maxVersion: "TLSv1.2",
                rejectUnauthorized: true,
                lookup: lookupIPv4,
            },
            () => {
                socket.end();
                resolve();
            }
        );
        socket.on("error", (err) => {
            console.error("[R2 TLS precheck] fallo handshake:", err?.message || err);
            reject(new Error("[R2] Handshake TLS falló contra endpoint."));
        });
    });
}

// --- SUBIR / BORRAR ---
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
    // devuelve la URL pública por compatibilidad (controllers existentes)
    return publicR2Url(objectKey);
}

export async function r2DeleteObject(objectKey: string) {
    if (SKIP_R2_TLS_PRECHECK !== "1") {
        await precheckTLS(ENDPOINT);
    }
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey });
    await r2.send(cmd);
}

// --- URL firmada (presigned GET) para buckets privados ---
export async function getSignedGetUrl(key: string, expiresSec = 3600) {
    const cmd = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });

    if (process.env.NODE_ENV !== "production") {
        console.log("[R2 presign] local time ISO:", new Date().toISOString());
    }

    let url = await getSignedUrl(r2Vhost, cmd, { expiresIn: expiresSec });

    // Hardening: eliminar x-amz-checksum-mode si algún middleware lo añadió
    url = url.replace(/([?&])x-amz-checksum-mode=[^&]+&?/i, "$1").replace(/[?&]$/, "");

    return url;
}

// --- helper que respeta R2_SIGNED_GET ---
export async function resolveR2Url(key: string, opts?: { expiresSec?: number }) {
    if (R2_SIGNED_GET === "1") {
        return getSignedGetUrl(key, opts?.expiresSec ?? 3600);
    }
    return publicR2Url(key);
}

// Re-export útil para controladores
export { GetObjectCommand };

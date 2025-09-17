"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetObjectCommand = exports.R2_PUBLIC_BASE = exports.R2_BUCKET_NAME = exports.r2 = void 0;
exports.publicR2Url = publicR2Url;
exports.makeObjectKeyForProduct = makeObjectKeyForProduct;
exports.r2PutObject = r2PutObject;
exports.r2DeleteObject = r2DeleteObject;
exports.getSignedGetUrl = getSignedGetUrl;
exports.resolveR2Url = resolveR2Url;
// src/lib/r2.ts
const client_s3_1 = require("@aws-sdk/client-s3");
Object.defineProperty(exports, "GetObjectCommand", { enumerable: true, get: function () { return client_s3_1.GetObjectCommand; } });
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const node_http_handler_1 = require("@smithy/node-http-handler");
const node_https_1 = __importDefault(require("node:https"));
const node_tls_1 = __importDefault(require("node:tls"));
const node_dns_1 = __importDefault(require("node:dns"));
const node_crypto_1 = require("node:crypto");
const node_url_1 = require("node:url");
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL, // base pública opcional
R2_ENDPOINT, // opcional
SKIP_R2_TLS_PRECHECK, // opcional
R2_SIGNED_GET, // "1" => preferir URL firmada en resolveR2Url
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
const lookupIPv4 = (hostname, options, callback) => {
    if (!hostname || typeof hostname !== "string") {
        const err = new Error("lookupIPv4: hostname inválido");
        if (typeof options === "function")
            return options(err);
        return callback?.(err);
    }
    if (typeof options === "function") {
        return node_dns_1.default.lookup(hostname, { family: 4, all: false }, options);
    }
    return node_dns_1.default.lookup(hostname, { family: 4, all: false }, callback);
};
const httpsAgent = new node_https_1.default.Agent({
    keepAlive: true,
    maxSockets: 50,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    honorCipherOrder: true,
});
// Cliente path-style para PUT/DELETE/GET directos (R2)
exports.r2 = new client_s3_1.S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    requestHandler: new node_http_handler_1.NodeHttpHandler({ httpsAgent }),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});
// Cliente vhost-style SOLO para presign GET (evita 401/403 con algunas CDNs)
const r2Vhost = new client_s3_1.S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: false, // virtual-hosted-style
    requestHandler: new node_http_handler_1.NodeHttpHandler({ httpsAgent }),
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});
exports.R2_BUCKET_NAME = R2_BUCKET;
// ---- Base pública (para bucket público) ----
const RAW_PUBLIC_BASE = (R2_PUBLIC_BASE_URL && R2_PUBLIC_BASE_URL.trim())
    ? R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
    : "";
function normalizePublicBase(raw, bucket) {
    if (!raw)
        return "";
    try {
        const u = new node_url_1.URL(raw);
        // si ya incluye el bucket en el path, no dupliques
        if (u.pathname && new RegExp(`/(^|)${bucket}(/|$)`).test(u.pathname)) {
            return raw.replace(/\/+$/, "");
        }
        return `${raw.replace(/\/+$/, "")}/${bucket}`;
    }
    catch {
        return `${raw.replace(/\/+$/, "")}/${bucket}`;
    }
}
exports.R2_PUBLIC_BASE = RAW_PUBLIC_BASE
    ? normalizePublicBase(RAW_PUBLIC_BASE, exports.R2_BUCKET_NAME)
    : "";
// helper pública (bucket público)
function publicR2Url(key) {
    if (!exports.R2_PUBLIC_BASE)
        throw new Error("[R2] Falta R2_PUBLIC_BASE_URL (o no incluye el bucket).");
    return `${exports.R2_PUBLIC_BASE}/${key.replace(/^\/+/, "")}`;
}
// Genera key para imágenes de producto
function makeObjectKeyForProduct(productId, originalName) {
    const ext = (originalName?.split(".").pop() || "bin").toLowerCase().replace(/[^\w]+/g, "");
    return `products/${productId}/${(0, node_crypto_1.randomUUID)()}.${ext || "bin"}`;
}
// ——— PRECHECK TLS ———
async function precheckTLS(endpoint) {
    const u = new node_url_1.URL(endpoint);
    const port = Number(u.port || 443);
    await new Promise((resolve, reject) => {
        const socket = node_tls_1.default.connect({
            host: u.hostname,
            port,
            servername: u.hostname,
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.2",
            rejectUnauthorized: true,
            lookup: lookupIPv4,
        }, () => {
            socket.end();
            resolve();
        });
        socket.on("error", (err) => {
            console.error("[R2 TLS precheck] fallo handshake:", err?.message || err);
            reject(new Error("[R2] Handshake TLS falló contra endpoint."));
        });
    });
}
// --- SUBIR / BORRAR ---
async function r2PutObject(objectKey, body, contentType) {
    if (SKIP_R2_TLS_PRECHECK !== "1") {
        await precheckTLS(ENDPOINT);
    }
    const cmd = new client_s3_1.PutObjectCommand({
        Bucket: exports.R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: contentType || "application/octet-stream",
    });
    await exports.r2.send(cmd);
    // devuelve la URL pública por compatibilidad (controllers existentes)
    return publicR2Url(objectKey);
}
async function r2DeleteObject(objectKey) {
    if (SKIP_R2_TLS_PRECHECK !== "1") {
        await precheckTLS(ENDPOINT);
    }
    const cmd = new client_s3_1.DeleteObjectCommand({ Bucket: exports.R2_BUCKET_NAME, Key: objectKey });
    await exports.r2.send(cmd);
}
// --- URL firmada (presigned GET) para buckets privados ---
async function getSignedGetUrl(key, expiresSec = 3600) {
    const cmd = new client_s3_1.GetObjectCommand({
        Bucket: exports.R2_BUCKET_NAME,
        Key: key,
        // No seteamos ChecksumMode para evitar x-amz-checksum-mode en la URL
    });
    if (process.env.NODE_ENV !== "production") {
        console.log("[R2 presign] local time ISO:", new Date().toISOString());
    }
    let url = await (0, s3_request_presigner_1.getSignedUrl)(r2Vhost, cmd, { expiresIn: expiresSec });
    // Hardening: eliminar x-amz-checksum-mode si algún middleware lo añadió
    url = url.replace(/([?&])x-amz-checksum-mode=[^&]+&?/i, "$1").replace(/[?&]$/, "");
    return url;
}
// --- helper que respeta R2_SIGNED_GET ---
async function resolveR2Url(key, opts) {
    if (R2_SIGNED_GET === "1") {
        return getSignedGetUrl(key, opts?.expiresSec ?? 3600);
    }
    return publicR2Url(key);
}

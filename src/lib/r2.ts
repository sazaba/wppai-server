// src/lib/r2.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL, // opcional: CDN/dominio público
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("[R2] Faltan variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET");
}

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

export const r2 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
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

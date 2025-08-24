import axios from "axios";
import FormData from "form-data";

const { R2_WORKER_UPLOAD_URL, R2_WORKER_DELETE_URL, R2_WORKER_TOKEN } = process.env;

export async function uploadToR2ViaWorker(params: {
    productId: number;
    buffer: Buffer;
    filename: string;
    contentType?: string;
    alt?: string;
    isPrimary?: boolean;
}) {
    if (!R2_WORKER_UPLOAD_URL) throw new Error("Falta R2_WORKER_UPLOAD_URL");

    const fd = new FormData();
    fd.append("productId", String(params.productId));
    if (params.alt) fd.append("alt", params.alt);
    if (params.isPrimary) fd.append("isPrimary", "true");
    fd.append("file", params.buffer, {
        filename: params.filename,
        contentType: params.contentType || "application/octet-stream",
    });

    const { data } = await axios.post(R2_WORKER_UPLOAD_URL, fd, {
        headers: {
            ...fd.getHeaders(),
            ...(R2_WORKER_TOKEN ? { Authorization: `Bearer ${R2_WORKER_TOKEN}` } : {}),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    if (!data?.ok) throw new Error("Worker upload failed");
    return {
        publicUrl: data.url as string,
        objectKey: data.objectKey as string,
        mimeType: data.mimeType as string,
        sizeBytes: data.sizeBytes as number,
        isPrimary: !!data.isPrimary,
    };
}

export async function deleteFromR2ViaWorker(objectKey: string) {
    const { R2_WORKER_DELETE_URL, R2_WORKER_TOKEN } = process.env as Record<string, string | undefined>
    if (!R2_WORKER_DELETE_URL) throw new Error("Falta R2_WORKER_DELETE_URL")

    const { default: axios } = await import("axios")
    const { data } = await axios.post(
        R2_WORKER_DELETE_URL,
        { objectKey },
        {
            headers: {
                "Content-Type": "application/json",
                ...(R2_WORKER_TOKEN ? { Authorization: `Bearer ${R2_WORKER_TOKEN}` } : {}),
            },
        }
    )
    if (!data?.ok) throw new Error("Worker delete failed")
    return true
}

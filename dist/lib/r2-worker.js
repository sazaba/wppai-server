"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToR2ViaWorker = uploadToR2ViaWorker;
exports.deleteFromR2ViaWorker = deleteFromR2ViaWorker;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const { R2_WORKER_UPLOAD_URL, R2_WORKER_DELETE_URL, R2_WORKER_TOKEN } = process.env;
async function uploadToR2ViaWorker(params) {
    if (!R2_WORKER_UPLOAD_URL)
        throw new Error("Falta R2_WORKER_UPLOAD_URL");
    const fd = new form_data_1.default();
    fd.append("productId", String(params.productId));
    if (params.alt)
        fd.append("alt", params.alt);
    if (params.isPrimary)
        fd.append("isPrimary", "true");
    fd.append("file", params.buffer, {
        filename: params.filename,
        contentType: params.contentType || "application/octet-stream",
    });
    const { data } = await axios_1.default.post(R2_WORKER_UPLOAD_URL, fd, {
        headers: {
            ...fd.getHeaders(),
            ...(R2_WORKER_TOKEN ? { Authorization: `Bearer ${R2_WORKER_TOKEN}` } : {}),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });
    if (!data?.ok)
        throw new Error("Worker upload failed");
    return {
        publicUrl: data.url,
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        isPrimary: !!data.isPrimary,
    };
}
async function deleteFromR2ViaWorker(objectKey) {
    const { R2_WORKER_DELETE_URL, R2_WORKER_TOKEN } = process.env;
    if (!R2_WORKER_DELETE_URL)
        throw new Error("Falta R2_WORKER_DELETE_URL");
    const { default: axios } = await Promise.resolve().then(() => __importStar(require("axios")));
    const { data } = await axios.post(R2_WORKER_DELETE_URL, { objectKey }, {
        headers: {
            "Content-Type": "application/json",
            ...(R2_WORKER_TOKEN ? { Authorization: `Bearer ${R2_WORKER_TOKEN}` } : {}),
        },
    });
    if (!data?.ok)
        throw new Error("Worker delete failed");
    return true;
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cfImagesUpload = cfImagesUpload;
exports.cfImagesDelete = cfImagesDelete;
exports.cfImageUrl = cfImageUrl;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const node_crypto_1 = require("node:crypto");
const { CF_ACCOUNT_ID, CF_IMAGES_API_TOKEN, CF_IMAGES_ACCOUNT_HASH } = process.env;
if (!CF_ACCOUNT_ID || !CF_IMAGES_API_TOKEN || !CF_IMAGES_ACCOUNT_HASH) {
    throw new Error('Faltan CF_ACCOUNT_ID / CF_IMAGES_API_TOKEN / CF_IMAGES_ACCOUNT_HASH');
}
// Variante por defecto (ponla también en Render)
const CF_IMAGES_VARIANT = process.env.CF_IMAGES_VARIANT || 'public';
const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`;
async function cfImagesUpload(buffer, filename = `${(0, node_crypto_1.randomUUID)()}.jpg`) {
    const form = new form_data_1.default();
    form.append('file', buffer, { filename });
    const { data } = await axios_1.default.post(API, form, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}`, ...form.getHeaders() },
        maxBodyLength: Infinity,
    });
    if (!data?.success)
        throw new Error('Cloudflare Images upload failed');
    return data.result;
}
async function cfImagesDelete(imageId) {
    const { data } = await axios_1.default.delete(`${API}/${imageId}`, {
        headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}` },
    });
    if (!data?.success)
        throw new Error('Cloudflare Images delete failed');
}
// 👉 siempre devuelve con VARIANTE nombrada
function cfImageUrl(imageId, variant = CF_IMAGES_VARIANT) {
    return `https://imagedelivery.net/${CF_IMAGES_ACCOUNT_HASH}/${imageId}/${variant}`;
}

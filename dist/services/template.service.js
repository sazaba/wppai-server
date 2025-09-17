"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTemplatesFromMeta = listTemplatesFromMeta;
exports.createTemplateInMeta = createTemplateInMeta;
exports.deleteTemplateInMeta = deleteTemplateInMeta;
const axios_1 = __importDefault(require("axios"));
const FB_VERSION = 'v20.0';
/**
 * Lista plantillas desde Meta (incluye components para extraer el BODY).
 */
async function listTemplatesFromMeta(wabaId, accessToken) {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`;
    const res = await axios_1.default.get(url, {
        params: { fields: 'name,language,category,status,components' },
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data?.data ?? [];
}
/**
 * Crea/publica una plantilla en Meta.
 * language debe ser string simple (ej: 'es', 'es_AR', 'en_US')
 * category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
 */
async function createTemplateInMeta(wabaId, accessToken, args) {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`;
    const payload = {
        name: args.name,
        language: args.language,
        category: args.category,
        components: [{ type: 'BODY', text: args.bodyText }],
    };
    const res = await axios_1.default.post(url, payload, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data;
}
/**
 * Elimina una plantilla en Meta por name + language.
 */
async function deleteTemplateInMeta(wabaId, accessToken, name, language) {
    const url = `https://graph.facebook.com/${FB_VERSION}/${wabaId}/message_templates`;
    const res = await axios_1.default.delete(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { name, language },
    });
    return res.data;
}

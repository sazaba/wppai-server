"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyCode = exports.requestVerificationCode = exports.setTwoStepPin = exports.estadoNumero = exports.activarNumero = exports.listarTelefonosDeWaba = void 0;
const axios_1 = __importDefault(require("axios"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const FB_VERSION = process.env.FB_VERSION || 'v22.0';
const SYSTEM_TOKEN = (process.env.WHATSAPP_TEMP_TOKEN || '').trim();
function onlyDigits(s) {
    return String(s || '').replace(/\D+/g, '');
}
function asMetaError(e) {
    const x = e?.response?.data?.error || e?.response?.data || e;
    return {
        ok: false,
        error: {
            message: x?.message || e?.message || 'Unknown error',
            type: x?.type,
            code: x?.code,
            error_subcode: x?.error_subcode,
            details: x,
        },
    };
}
/** GET /api/whatsapp/waba/:wabaId/phones */
const listarTelefonosDeWaba = async (req, res) => {
    try {
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const { wabaId } = req.params;
        if (!wabaId)
            return res.status(400).json({ ok: false, error: 'Falta wabaId' });
        const { data } = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${wabaId}/phone_numbers`, { headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` } });
        return res.json({ ok: true, data: data?.data || [] });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.listarTelefonosDeWaba = listarTelefonosDeWaba;
async function findPhoneIdInWaba(wabaId, displayPhoneNumber) {
    const { data } = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${wabaId}/phone_numbers`, { headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` } });
    const list = Array.isArray(data?.data) ? data.data : [];
    if (!list.length)
        return { phoneId: null };
    if (!displayPhoneNumber) {
        if (list.length === 1)
            return { phoneId: list[0].id, phone: list[0] };
        return { phoneId: null };
    }
    const wanted = onlyDigits(displayPhoneNumber);
    const match = list.find(p => onlyDigits(p?.display_phone_number) === wanted);
    return { phoneId: match?.id || null, phone: match };
}
// src/controllers/whatsapp.register.controller.ts
const activarNumero = async (req, res) => {
    try {
        const empresaId = req.user?.empresaId;
        if (!empresaId)
            return res.status(401).json({ ok: false, error: 'No autorizado' });
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const { wabaId, phoneNumberId: bodyPhoneId, displayPhoneNumber, pin } = (req.body || {});
        if (!wabaId)
            return res.status(400).json({ ok: false, error: 'Falta wabaId' });
        // ⚠️ En este caso Meta exige PIN. Lo volvemos obligatorio.
        const cleanPin = String(pin || '').trim();
        if (!/^\d{6}$/.test(cleanPin)) {
            return res.status(400).json({
                ok: false,
                error: 'Meta exige PIN de 6 dígitos para registrar este número. Ingresa el PIN correcto.',
            });
        }
        let phoneNumberId = (bodyPhoneId || '').trim();
        let phone;
        if (!phoneNumberId) {
            const r = await findPhoneIdInWaba(wabaId, (displayPhoneNumber || '').trim());
            phoneNumberId = r.phoneId || '';
            phone = r.phone;
            if (!phoneNumberId) {
                return res.status(404).json({
                    ok: false,
                    error: displayPhoneNumber
                        ? `No se encontró phone_number_id para ${displayPhoneNumber} en esta WABA`
                        : 'Hay más de un número en la WABA. Debes indicar displayPhoneNumber o phoneNumberId',
                });
            }
        }
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/register`;
        const payload = { messaging_product: 'whatsapp', pin: cleanPin };
        try {
            await axios_1.default.post(url, payload, {
                headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
            });
        }
        catch (e) {
            const err = e?.response?.data?.error;
            const code = err?.code;
            const msg = err?.message || '';
            // Mapear errores comunes con explicación clara
            if (code === 100 && /pin is required/i.test(msg)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Meta exige PIN para este número. Debes ingresar un PIN de 6 dígitos (el ya configurado previamente).',
                });
            }
            if (code === 133005 || /two step verification pin mismatch/i.test(msg)) {
                return res.status(400).json({
                    ok: false,
                    error: 'PIN incorrecto. Este número ya tiene un PIN configurado anteriormente. Debes usar ese PIN exacto o solicitar el reset desde WhatsApp Manager / soporte de Meta.',
                    details: err,
                });
            }
            console.error('[WA REGISTER ERROR]', {
                url,
                payload,
                code: err?.code,
                subcode: err?.error_subcode,
                type: err?.type,
                message: msg,
                error_data: err?.error_data,
                fbtrace_id: err?.fbtrace_id,
            });
            return res.status(400).json({
                ok: false,
                error: msg || 'Error de Meta al registrar el número',
                details: err,
            });
        }
        await prisma_1.default.whatsappAccount.upsert({
            where: { empresaId },
            update: {
                wabaId,
                phoneNumberId,
                displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
                updatedAt: new Date(),
            },
            create: {
                empresaId,
                wabaId,
                phoneNumberId,
                displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
                accessToken: '',
            },
        });
        return res.json({
            ok: true,
            message: 'Número activado (registro exitoso).',
            wabaId,
            phoneNumberId,
            displayPhoneNumber: phone?.display_phone_number || displayPhoneNumber || null,
        });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.activarNumero = activarNumero;
/** GET /api/whatsapp/numero/:phoneNumberId/estado */
const estadoNumero = async (req, res) => {
    try {
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const phoneNumberId = req.params.phoneNumberId;
        if (!phoneNumberId)
            return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' });
        const { data } = await axios_1.default.get(`https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}`, {
            params: {
                fields: 'id,display_phone_number,quality_rating,name_status,account_mode,verified_name,status',
                access_token: SYSTEM_TOKEN,
            },
        });
        return res.json({ ok: true, data });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.estadoNumero = estadoNumero;
/** POST /api/whatsapp/numero/:phoneNumberId/two-step
 *  Body: { pin: "123456" }
 *  Configura/actualiza el PIN (two-step verification) del número.
 */
const setTwoStepPin = async (req, res) => {
    try {
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const phoneNumberId = (req.params?.phoneNumberId || '').trim();
        const pin = (req.body?.pin || '').toString().trim();
        if (!phoneNumberId)
            return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' });
        if (!/^\d{6}$/.test(pin))
            return res.status(400).json({ ok: false, error: 'PIN inválido: debe ser de 6 dígitos' });
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/two_step_verification`;
        const payload = { pin };
        const { data } = await axios_1.default.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        });
        return res.json({ ok: true, data });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.setTwoStepPin = setTwoStepPin;
/** POST /api/whatsapp/numero/:phoneNumberId/request-code
 *  Body: { code_method?: "SMS"|"VOICE", locale?: "en_US"|"es_ES"|... }
 *  (Opcional) Pide código de verificación del número (proceso clásico).
 */
const requestVerificationCode = async (req, res) => {
    try {
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const phoneNumberId = (req.params?.phoneNumberId || '').trim();
        if (!phoneNumberId)
            return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' });
        const code_method = (req.body?.code_method || 'SMS').toString().toUpperCase();
        const locale = (req.body?.locale || 'en_US').toString();
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/request_code`;
        const payload = { code_method, locale };
        const { data } = await axios_1.default.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        });
        return res.json({ ok: true, data });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.requestVerificationCode = requestVerificationCode;
/** POST /api/whatsapp/numero/:phoneNumberId/verify-code
 *  Body: { code: "123456" }
 *  (Opcional) Verifica el código recibido en el paso anterior.
 */
const verifyCode = async (req, res) => {
    try {
        if (!SYSTEM_TOKEN)
            return res.status(500).json({ ok: false, error: 'WHATSAPP_TEMP_TOKEN no configurado' });
        const phoneNumberId = (req.params?.phoneNumberId || '').trim();
        const code = (req.body?.code || '').toString().trim();
        if (!phoneNumberId)
            return res.status(400).json({ ok: false, error: 'Falta phoneNumberId' });
        if (!/^\d{6}$/.test(code))
            return res.status(400).json({ ok: false, error: 'Código inválido: debe ser de 6 dígitos' });
        const url = `https://graph.facebook.com/${FB_VERSION}/${phoneNumberId}/verify_code`;
        const payload = { code };
        const { data } = await axios_1.default.post(url, payload, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
        });
        return res.json({ ok: true, data });
    }
    catch (e) {
        return res.status(400).json(asMetaError(e));
    }
};
exports.verifyCode = verifyCode;

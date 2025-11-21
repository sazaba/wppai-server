// src/services/wompi.service.ts
import axios from "axios";
import crypto from "crypto";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL =
    process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY!;

// Cache en memoria del acceptance_token (para no pedirlo en cada request)
let acceptanceTokenCache: string | null = null;

/* ============================================================
   1) Obtener (y cachear) el acceptance_token del comercio
============================================================ */

export async function getAcceptanceToken(): Promise<string> {
    if (acceptanceTokenCache) return acceptanceTokenCache;

    console.log("💼 [WOMPI] Obteniendo acceptance_token...");
    console.log("   → BASE_URL:", WOMPI_BASE_URL);
    console.log("   → PUBLIC_KEY:", WOMPI_PUBLIC_KEY);

    const res = await axios.get(`${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`);

    const token = res.data?.data?.presigned_acceptance?.acceptance_token;
    const hasPresigned = !!res.data?.data?.presigned_acceptance;

    console.log("   ↳ /merchants status:", res.status, "hasPresigned:", hasPresigned);

    if (!token) {
        console.error("   ❌ No se pudo obtener presigned_acceptance en la respuesta de Wompi");
        throw new Error("No se pudo obtener el acceptance_token de Wompi");
    }

    acceptanceTokenCache = token;
    console.log("   ✅ acceptance_token cacheado (longitud):", token.length);

    return token;
}

/* ============================================================
   2) Crear token de tarjeta (tok_test_xxx)
============================================================ */

export async function createPaymentSource(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
    console.log("💳 [WOMPI] Creando token de tarjeta...");
    console.log("   → POST /tokens/cards");

    try {
        const response = await axios.post(
            `${WOMPI_BASE_URL}/tokens/cards`,
            {
                number: cardData.number,
                cvc: cardData.cvc,
                exp_month: cardData.exp_month,
                exp_year: cardData.exp_year,
                card_holder: cardData.card_holder,
            },
            {
                headers: {
                    Authorization: `Bearer ${WOMPI_PUBLIC_KEY}`,
                },
            }
        );

        const data = response.data.data;
        console.log("   ✅ Token creado:", {
            id: data?.id,
            brand: data?.brand,
            last_four: data?.last_four,
        });

        return data; // token Wompi
    } catch (err: any) {
        console.error("   ❌ Error creando token de tarjeta en Wompi");
        console.error("   Status:", err.response?.status);
        console.error("   Data:", err.response?.data || err.message);
        throw err;
    }
}

/* ============================================================
   3) Cobro con token (CARD)
   - Usa acceptance_token
   - Calcula signature con HMAC-SHA256 e INTEGRITY_KEY:
     reference + amount_in_cents + currency
============================================================ */

export async function chargeWithToken({
    token,
    amountInCents,
    currency = "COP",
    customerEmail,
    reference,
}: {
    token: string;
    amountInCents: number;
    currency?: string;
    customerEmail: string;
    reference: string;
}) {
    // 1. Obtener acceptance_token
    const acceptance_token = await getAcceptanceToken();

    // 2. Asegurar entero en centavos
    const amount = Math.trunc(amountInCents);

    // 3. Payload para firma (según doc de Wompi)
    const signaturePayload = `${reference}${amount}${currency}`;

    // 4. HMAC-SHA256 con INTEGRITY_KEY
    const signature = crypto
        .createHmac("sha256", WOMPI_INTEGRITY_KEY)
        .update(signaturePayload)
        .digest("hex");

    console.log("💸 [WOMPI] Iniciando cobro con token...");
    console.log("   → token:", token);
    console.log("   → amount_in_cents:", amount);
    console.log("   → currency:", currency);
    console.log("   → reference:", reference);
    console.log("   → acceptance_token (len):", acceptance_token.length);
    console.log("   → signaturePayload:", signaturePayload);
    console.log("   → signature (hmac sha256):", signature);

    const body = {
        amount_in_cents: amount,
        currency,
        customer_email: customerEmail,
        reference,
        acceptance_token,
        payment_method: {
            type: "CARD",
            token,
            installments: 1,
        },
        signature, // 👈 se envía la firma calculada
    };

    console.log("   → POST", `${WOMPI_BASE_URL}/transactions`);
    console.log("   📦 Payload enviado a Wompi:", {
        ...body,
        acceptance_token: `len:${acceptance_token.length}`,
    });

    try {
        const response = await axios.post(`${WOMPI_BASE_URL}/transactions`, body, {
            headers: {
                Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            },
        });

        console.log("   ✅ Transacción creada en Wompi:", {
            id: response.data?.data?.id,
            status: response.data?.data?.status,
        });

        return response.data; // el controller usará esto
    } catch (err: any) {
        console.error("   ❌ ERROR en cobro Wompi");
        console.error("   Status:", err.response?.status);
        console.error("   Data:", err.response?.data || err.message);
        throw err;
    }
}

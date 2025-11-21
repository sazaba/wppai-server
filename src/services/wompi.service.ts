// src/services/wompi.service.ts
import axios from "axios";
import crypto from "crypto";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL =
    process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY!;

// Cache en memoria del acceptance_token
let acceptanceTokenCache: string | null = null;

/* =======================================================
   Helper: obtener acceptance_token del comercio
======================================================= */
export async function getAcceptanceToken(): Promise<string> {
    if (acceptanceTokenCache) return acceptanceTokenCache;

    console.log("💡 [WOMPI] getAcceptanceToken() …");
    console.log("   BASE_URL:", WOMPI_BASE_URL);
    console.log("   PUBLIC_KEY:", WOMPI_PUBLIC_KEY?.slice(0, 12) + "...");

    const res = await axios.get(`${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`);

    const hasPresigned = !!res.data?.data?.presigned_acceptance;
    const token = res.data?.data?.presigned_acceptance?.acceptance_token;

    console.log("   → status:", res.status, "hasPresigned:", hasPresigned);

    if (!token) {
        console.error("   ❌ No se encontró presigned_acceptance en /merchants");
        throw new Error("No se pudo obtener el acceptance_token de Wompi");
    }

    acceptanceTokenCache = token;
    console.log("   ✅ acceptance_token cacheado (longitud):", token.length);

    return token;
}

/* =======================================================
   Crear token de tarjeta (tok_test_…)
======================================================= */
export async function createPaymentSource(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
    console.log("💳 [WOMPI] Creando token de tarjeta…");
    console.log("   BASE_URL:", WOMPI_BASE_URL);

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

    const data = response.data?.data;
    console.log("   ✅ Token creado:", {
        id: data?.id,
        brand: data?.brand,
        last_four: data?.last_four,
    });

    return data; // token Wompi
}

/* =======================================================
   Cobrar usando token de tarjeta
   - Usa acceptance_token
   - Usa signature (HMAC-SHA256 con INTEGRITY_KEY)
======================================================= */
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
    // 1) acceptance_token
    const acceptance_token = await getAcceptanceToken();

    // 2) monto en centavos entero
    const amount = Math.trunc(amountInCents);

    // 3) payload de firma según Wompi:
    //    reference + amount_in_cents + currency  (sin separadores)
    const signaturePayload = `${reference}${amount}${currency}`;

    const signature = crypto
        .createHmac("sha256", WOMPI_INTEGRITY_KEY)
        .update(signaturePayload)
        .digest("hex");

    console.log("💸 [WOMPI] Iniciando cobro con token…");
    console.log("   token:", token);
    console.log("   amount_in_cents:", amount);
    console.log("   currency:", currency);
    console.log("   reference:", reference);
    console.log("   acceptance_token.len:", acceptance_token.length);
    console.log("   integrity_key.prefix:", WOMPI_INTEGRITY_KEY.slice(0, 12) + "…");
    console.log("   signaturePayload:", signaturePayload);
    console.log("   signature:", signature);

    try {
        const response = await axios.post(
            `${WOMPI_BASE_URL}/transactions`,
            {
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
                signature,
            },
            {
                headers: {
                    Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
                },
            }
        );

        console.log("   ✅ [WOMPI] Transaction OK:", {
            status: response.status,
            id: response.data?.data?.id,
            statusTxn: response.data?.data?.status,
        });

        // OJO: aquí devolvemos directamente response.data
        return response.data;
    } catch (err: any) {
        console.error("   ❌ [WOMPI] Error en /transactions");
        console.error("   Status:", err.response?.status);
        console.error("   Data:", err.response?.data || err.message);
        throw err;
    }
}

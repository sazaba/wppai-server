// src/services/wompi.service.ts
import axios from "axios";

function safe(v?: string | null) {
    if (!v) return "undefined";
    if (v.length < 8) return v;
    return v.slice(0, 4) + "..." + v.slice(-4);
}

console.log("🔧 [WOMPI CONFIG]");
console.log("  WOMPI_PUBLIC_KEY:", safe(process.env.WOMPI_PUBLIC_KEY));
console.log("  WOMPI_PRIVATE_KEY:", safe(process.env.WOMPI_PRIVATE_KEY));
console.log("  WOMPI_BASE_URL:", process.env.WOMPI_BASE_URL);
console.log("  WOMPI_INTEGRITY_KEY:", safe(process.env.WOMPI_INTEGRITY_KEY));

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL =
    process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";

// Cache del acceptance token
let acceptanceTokenCache: string | null = null;

/* ======================================================
   🔹 GET acceptance_token
====================================================== */
export async function getAcceptanceToken(): Promise<string> {
    console.log("⚡ [WOMPI] Solicitando acceptance_token...");

    if (acceptanceTokenCache) {
        console.log("⚡ [WOMPI] acceptance_token cacheado:", safe(acceptanceTokenCache));
        return acceptanceTokenCache;
    }

    try {
        const url = `${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`;
        console.log("🌐 GET", url);

        const res = await axios.get(url);

        console.log("📥 Respuesta /merchants:", {
            status: res.status,
            hasPresigned: !!res.data?.data?.presigned_acceptance,
        });

        const token = res.data?.data?.presigned_acceptance?.acceptance_token;

        if (!token) {
            console.error("❌ No se encontró acceptance_token en /merchants");
            console.error(JSON.stringify(res.data, null, 2));
            throw new Error("No se pudo obtener acceptance_token");
        }

        acceptanceTokenCache = token;

        console.log("✅ acceptance_token obtenido:", safe(token));
        return token;
    } catch (err: any) {
        console.error("🔥 ERROR obteniendo acceptance_token");
        console.error(err.response?.data || err.message);
        throw err;
    }
}

/* ======================================================
   🔹 CREATE TOKEN DE TARJETA
====================================================== */
export async function createPaymentSource(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
    console.log("💳 [WOMPI] Creando token de tarjeta...");

    const url = `${WOMPI_BASE_URL}/tokens/cards`;
    console.log("→ POST", url);

    try {
        const response = await axios.post(
            url,
            { ...cardData },
            {
                headers: {
                    Authorization: `Bearer ${WOMPI_PUBLIC_KEY}`,
                },
            }
        );

        console.log("💳 Token creado:", {
            id: response.data?.data?.id,
            brand: response.data?.data?.brand,
            last_four: response.data?.data?.last_four,
        });

        return response.data.data;
    } catch (err: any) {
        console.error("🔥 ERROR creando token de tarjeta");
        console.error("Status:", err.response?.status);
        console.error("Data:", err.response?.data);
        throw err;
    }
}

/* ======================================================
   🔹 COBRAR CON TOKEN
====================================================== */
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
    console.log("💸 [WOMPI] Iniciando cobro con token...");
    console.log("👉 token:", token);
    console.log("👉 amount:", amountInCents);
    console.log("👉 reference:", reference);

    const acceptance_token = await getAcceptanceToken();

    const url = `${WOMPI_BASE_URL}/transactions`;
    console.log("→ POST", url);

    const payload = {
        amount_in_cents: Math.trunc(amountInCents),
        currency,
        customer_email: customerEmail,
        reference,
        acceptance_token,
        payment_method: {
            type: "CARD",
            token,
            installments: 1,
        },
    };

    console.log("📦 Payload enviado a Wompi:", {
        ...payload,
        acceptance_token: safe(payload.acceptance_token),
    });

    try {
        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            },
        });

        console.log("📥 Respuesta de Wompi:", {
            status: response.status,
            transactionId: response.data?.data?.id,
            statusWompi: response.data?.data?.status,
        });

        return response.data;
    } catch (err: any) {
        console.error("🔥 ERROR en cobro Wompi");
        console.error("Status:", err.response?.status);
        console.error("Data:", err.response?.data);
        throw err;
    }
}

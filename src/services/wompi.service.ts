// src/services/wompi.service.ts
import axios from "axios";
import crypto from "crypto";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL =
    process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY!;

/* ============================================================
   Cache en memoria de tokens de aceptación
============================================================ */

type AcceptanceTokens = {
    acceptance_token: string;
    accept_personal_auth: string;
};

let acceptanceTokensCache: AcceptanceTokens | null = null;

/* ============================================================
   1) Obtener (y cachear) tokens de aceptación del comercio
============================================================ */

export async function getAcceptanceTokens(): Promise<AcceptanceTokens> {
    if (acceptanceTokensCache) return acceptanceTokensCache;

    console.log("💼 [WOMPI] Obteniendo tokens de aceptación...");
    console.log("   → BASE_URL:", WOMPI_BASE_URL);
    console.log("   → PUBLIC_KEY:", WOMPI_PUBLIC_KEY);

    const res = await axios.get(`${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`);

    const presigned = res.data?.data?.presigned_acceptance;
    const personal = res.data?.data?.presigned_personal_data_auth;

    const acceptance_token = presigned?.acceptance_token;
    const accept_personal_auth = personal?.acceptance_token;

    console.log(
        "   ↳ /merchants status:",
        res.status,
        "hasPresigned:",
        !!presigned,
        "hasPersonalAuth:",
        !!personal
    );

    if (!acceptance_token || !accept_personal_auth) {
        console.error(
            "   ❌ No se pudieron obtener ambos tokens de aceptación en la respuesta de Wompi"
        );
        throw new Error("No se pudieron obtener los tokens de aceptación de Wompi");
    }

    acceptanceTokensCache = { acceptance_token, accept_personal_auth };

    console.log("   ✅ acceptance_token length:", acceptance_token.length);
    console.log("   ✅ accept_personal_auth length:", accept_personal_auth.length);

    return acceptanceTokensCache;
}

// Compatibilidad si en algún punto se usa solo getAcceptanceToken
export async function getAcceptanceToken(): Promise<string> {
    const { acceptance_token } = await getAcceptanceTokens();
    return acceptance_token;
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
   - Usa tokens de aceptación (privacy + personal data)
   - Calcula signature con SHA256:
     reference + amount_in_cents + currency + INTEGRITY_KEY
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
    // 1. Obtener ambos tokens de aceptación
    const { acceptance_token, accept_personal_auth } = await getAcceptanceTokens();

    // 2. Asegurar entero en centavos
    const amount = Math.trunc(amountInCents);

    // 3. Cadena para la firma:
    // "<Referencia><MontoEnCentavos><Moneda><SecretoDeIntegridad>"
    const signaturePlain = `${reference}${amount}${currency}${WOMPI_INTEGRITY_KEY}`;

    // 4. SHA256 simple (NO HMAC)
    const signature = crypto.createHash("sha256").update(signaturePlain).digest("hex");

    console.log("💸 [WOMPI] Iniciando cobro con token...");
    console.log("   → token:", token);
    console.log("   → amount_in_cents:", amount);
    console.log("   → currency:", currency);
    console.log("   → reference:", reference);
    console.log("   → acceptance_token (len):", acceptance_token.length);
    console.log("   → accept_personal_auth (len):", accept_personal_auth.length);
    console.log("   → signaturePlain:", signaturePlain);
    console.log("   → signature (sha256):", signature);

    const body = {
        amount_in_cents: amount,
        currency,
        customer_email: customerEmail,
        reference,
        acceptance_token,
        accept_personal_auth,
        payment_method: {
            type: "CARD",
            token,
            installments: 1,
        },
        signature,
    };

    console.log("   → POST", `${WOMPI_BASE_URL}/transactions`);
    console.log("   📦 Payload enviado a Wompi:", {
        ...body,
        acceptance_token: `len:${acceptance_token.length}`,
        accept_personal_auth: `len:${accept_personal_auth.length}`,
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

        // devolvemos response.data (para ser consistente con tu implementación)
        return response.data;
    } catch (err: any) {
        console.error("   ❌ ERROR en cobro Wompi");
        console.error("   Status:", err.response?.status);
        console.error("   Data:", err.response?.data || err.message);
        throw err;
    }
}

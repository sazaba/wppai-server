// // src/services/wompi.service.ts
// import axios from "axios";
// import crypto from "crypto";

// const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
// const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
// const WOMPI_BASE_URL =
//     process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";
// const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY!;

// /* ============================================================
//    Cache en memoria de tokens de aceptación
// ============================================================ */

// type AcceptanceTokens = {
//     acceptance_token: string;
//     accept_personal_auth: string;
// };

// let acceptanceTokensCache: AcceptanceTokens | null = null;

// /* ============================================================
//    1) Obtener (y cachear) tokens de aceptación del comercio
// ============================================================ */

// export async function getAcceptanceTokens(): Promise<AcceptanceTokens> {
//     if (acceptanceTokensCache) return acceptanceTokensCache;

//     console.log("💼 [WOMPI] Obteniendo tokens de aceptación...");
//     console.log("   → BASE_URL:", WOMPI_BASE_URL);
//     console.log("   → PUBLIC_KEY:", WOMPI_PUBLIC_KEY);

//     const res = await axios.get(
//         `${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`
//     );

//     const presigned = res.data?.data?.presigned_acceptance;
//     const personal = res.data?.data?.presigned_personal_data_auth;

//     const acceptance_token = presigned?.acceptance_token;
//     const accept_personal_auth = personal?.acceptance_token;

//     console.log(
//         "   ↳ /merchants status:",
//         res.status,
//         "hasPresigned:",
//         !!presigned,
//         "hasPersonalAuth:",
//         !!personal
//     );

//     if (!acceptance_token || !accept_personal_auth) {
//         console.error(
//             "   ❌ No se pudieron obtener ambos tokens de aceptación en la respuesta de Wompi"
//         );
//         throw new Error(
//             "No se pudieron obtener los tokens de aceptación de Wompi"
//         );
//     }

//     acceptanceTokensCache = { acceptance_token, accept_personal_auth };

//     console.log("   ✅ acceptance_token length:", acceptance_token.length);
//     console.log(
//         "   ✅ accept_personal_auth length:",
//         accept_personal_auth.length
//     );

//     return acceptanceTokensCache;
// }

// // Compatibilidad: obtener SOLO el acceptance_token "principal"
// export async function getAcceptanceToken(): Promise<string> {
//     const { acceptance_token } = await getAcceptanceTokens();
//     return acceptance_token;
// }

// /* ============================================================
//    2) Crear token de tarjeta (tok_xxx) – LEGACY
//    ⚠️ IMPORTANTE: el token es de UN SOLO USO (payment_source O transacción)
// ============================================================ */

// export async function createPaymentSource(cardData: {
//     number: string;
//     cvc: string;
//     exp_month: string;
//     exp_year: string;
//     card_holder: string;
// }) {
//     console.log("💳 [WOMPI] Creando token de tarjeta (LEGACY)...");
//     console.log("   → POST /tokens/cards");

//     try {
//         const response = await axios.post(
//             `${WOMPI_BASE_URL}/tokens/cards`,
//             {
//                 number: cardData.number,
//                 cvc: cardData.cvc,
//                 exp_month: cardData.exp_month,
//                 exp_year: cardData.exp_year,
//                 card_holder: cardData.card_holder,
//             },
//             {
//                 headers: {
//                     Authorization: `Bearer ${WOMPI_PUBLIC_KEY}`,
//                 },
//             }
//         );

//         const data = response.data.data;
//         console.log("   ✅ Token creado:", {
//             id: data?.id,
//             brand: data?.brand,
//             last_four: data?.last_four,
//         });

//         return data; // token Wompi
//     } catch (err: any) {
//         console.error("   ❌ Error creando token de tarjeta en Wompi");
//         console.error("   Status:", err.response?.status);
//         console.error("   Data:", err.response?.data || err.message);
//         throw err;
//     }
// }

// /* ============================================================
//    3) Crear Payment Source (3DS)
// ============================================================ */

// export async function createPaymentSource3DS(data: {
//     number: string;
//     cvc: string;
//     exp_month: string;
//     exp_year: string;
//     card_holder: string;
//     deviceFingerprint: string;
//     customerEmail?: string;
// }) {
//     console.log("💳 [WOMPI] Creando payment source (3DS)...");
//     console.log("   → POST /payment_sources");

//     // 1) Obtener acceptance_token (solo el principal)
//     const acceptance_token = await getAcceptanceToken();

//     // 2) Crear token de tarjeta (tok_...) usando la función legacy
//     console.log("💳 [WOMPI] Creando token de tarjeta (LEGACY)...");
//     console.log("   → POST /tokens/cards");

//     const cardToken = await createPaymentSource({
//         number: data.number,
//         cvc: data.cvc,
//         exp_month: data.exp_month,
//         exp_year: data.exp_year,
//         card_holder: data.card_holder,
//     });

//     console.log("   ✅ Card token creado para 3DS:", {
//         id: cardToken?.id,
//         brand: cardToken?.brand,
//         last_four: cardToken?.last_four,
//     });

//     const body = {
//         type: "CARD",
//         token: cardToken.id, // 👈 solo el id del token (SE CONSUME AQUÍ)
//         acceptance_token,
//         device_fingerprint: data.deviceFingerprint,
//         customer_email: data.customerEmail,
//     };

//     try {
//         const res = await axios.post(
//             `${WOMPI_BASE_URL}/payment_sources`,
//             body,
//             {
//                 headers: {
//                     // 👇 IMPORTANTE: usar la PRIVATE KEY
//                     Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
//                 },
//             }
//         );

//         const source = res.data?.data;

//         console.log("   ✅ Payment source creado (3DS):", {
//             id: source?.id,
//             status: source?.status,
//             redirect_url: source?.redirect_url,
//         });

//         // Devolvemos ambas cosas, como espera el controller
//         return { source, cardToken };
//     } catch (err: any) {
//         console.error("   ❌ Error creando payment source en Wompi (3DS)");
//         console.error("   Status:", err.response?.status);
//         console.error("   Data:", err.response?.data || err.message);
//         throw err;
//     }
// }

// /* ============================================================
//    4) Cobro con token (CARD)
//    ⚠️ ÚSALO SOLO SI NO CREASTE payment_source ANTES.
// ============================================================ */

// export async function chargeWithToken({
//     token,
//     amountInCents,
//     currency = "COP",
//     customerEmail,
//     reference,
// }: {
//     token: string;
//     amountInCents: number;
//     currency?: string;
//     customerEmail: string;
//     reference: string;
// }) {
//     const amount = Math.trunc(amountInCents);
//     const signaturePlain = `${reference}${amount}${currency}${WOMPI_INTEGRITY_KEY}`;
//     const signature = crypto
//         .createHash("sha256")
//         .update(signaturePlain)
//         .digest("hex");

//     // 🔹 Obtener acceptance_token para la transacción
//     const acceptance_token = await getAcceptanceToken();

//     console.log("💸 [WOMPI] Iniciando cobro con token...");
//     console.log("   → token:", token);
//     console.log("   → amount_in_cents:", amount);
//     console.log("   → currency:", currency);
//     console.log("   → reference:", reference);
//     console.log("   → signaturePlain:", signaturePlain);
//     console.log("   → signature (sha256):", signature);
//     console.log(
//         "   → acceptance_token (len):",
//         acceptance_token ? acceptance_token.length : 0
//     );

//     const body = {
//         amount_in_cents: amount,
//         currency,
//         customer_email: customerEmail,
//         reference,
//         payment_method: {
//             type: "CARD",
//             token,
//             installments: 1,
//         },
//         signature,
//         acceptance_token,
//     };

//     console.log("   → POST", `${WOMPI_BASE_URL}/transactions`);
//     console.log("   → Body:", JSON.stringify(body, null, 2));

//     try {
//         const response = await axios.post(
//             `${WOMPI_BASE_URL}/transactions`,
//             body,
//             {
//                 headers: {
//                     Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
//                 },
//             }
//         );

//         console.log("   ✅ Transacción creada en Wompi:", {
//             id: response.data?.data?.id,
//             status: response.data?.data?.status,
//         });

//         return response.data;
//     } catch (err: any) {
//         console.error("   ❌ ERROR en cobro Wompi (token)");
//         console.error("   Status:", err.response?.status);
//         console.error(
//             "   Data:",
//             err.response?.data
//                 ? JSON.stringify(err.response.data, null, 2)
//                 : err.message
//         );
//         throw err;
//     }
// }

// /* ============================================================
//    5) Cobro con Payment Source (RECURRENTE / SUSCRIPCIONES)
//    ✅ ESTE ES EL QUE USAREMOS PARA chargeSubscription
// ============================================================ */

// export async function chargeWithPaymentSource({
//     paymentSourceId,
//     amountInCents,
//     currency = "COP",
//     customerEmail,
//     reference,
// }: {
//     paymentSourceId: string;
//     amountInCents: number;
//     currency?: string;
//     customerEmail: string;
//     reference: string;
// }) {
//     const amount = Math.trunc(amountInCents);
//     const signaturePlain = `${reference}${amount}${currency}${WOMPI_INTEGRITY_KEY}`;
//     const signature = crypto
//         .createHash("sha256")
//         .update(signaturePlain)
//         .digest("hex");

//     // 🔹 También usamos acceptance_token aquí
//     const acceptance_token = await getAcceptanceToken();

//     console.log(
//         "💸 [WOMPI] Iniciando cobro con Payment Source (RECURRENTE)..."
//     );
//     console.log("   → payment_source_id:", paymentSourceId);
//     console.log("   → amount_in_cents:", amount);
//     console.log("   → currency:", currency);
//     console.log("   → reference:", reference);
//     console.log("   → signaturePlain:", signaturePlain);
//     console.log("   → signature (sha256):", signature);
//     console.log(
//         "   → acceptance_token (len):",
//         acceptance_token ? acceptance_token.length : 0
//     );

//     const body = {
//         amount_in_cents: amount,
//         currency,
//         customer_email: customerEmail,
//         reference,
//         payment_method: {
//             type: "CARD",
//             payment_source_id: paymentSourceId,
//             installments: 1,
//         },
//         signature,
//         acceptance_token,
//     };

//     console.log("   → POST", `${WOMPI_BASE_URL}/transactions`);
//     console.log("   → Body:", JSON.stringify(body, null, 2));

//     try {
//         const response = await axios.post(
//             `${WOMPI_BASE_URL}/transactions`,
//             body,
//             {
//                 headers: {
//                     Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
//                 },
//             }
//         );

//         console.log("   ✅ Transacción creada en Wompi (Payment Source):", {
//             id: response.data?.data?.id,
//             status: response.data?.data?.status,
//         });

//         return response.data;
//     } catch (err: any) {
//         console.error("   ❌ ERROR en cobro Wompi (Payment Source)");
//         console.error("   Status:", err.response?.status);
//         console.error(
//             "   Data:",
//             err.response?.data
//                 ? JSON.stringify(err.response.data, null, 2)
//                 : err.message
//         );
//         throw err;
//     }
// }

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
   1) Obtener (y cachear) tokens de aceptación
============================================================ */
export async function getAcceptanceTokens(): Promise<AcceptanceTokens> {
    if (acceptanceTokensCache) return acceptanceTokensCache;

    console.log("💼 [WOMPI] Obteniendo tokens de aceptación...");

    try {
        const res = await axios.get(`${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`);
        const presigned = res.data?.data?.presigned_acceptance;
        const personal = res.data?.data?.presigned_personal_data_auth;

        if (!presigned?.acceptance_token || !personal?.acceptance_token) {
            throw new Error("No se pudieron obtener los tokens de aceptación");
        }

        acceptanceTokensCache = {
            acceptance_token: presigned.acceptance_token,
            accept_personal_auth: personal.acceptance_token
        };
        return acceptanceTokensCache;
    } catch (error) {
        console.error("Error obteniendo acceptance tokens:", error);
        throw error;
    }
}

export async function getAcceptanceToken(): Promise<string> {
    const { acceptance_token } = await getAcceptanceTokens();
    return acceptance_token;
}

/* ============================================================
   2) Tokenizar Tarjeta
============================================================ */
export async function tokenizeCard(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
    console.log("💳 [WOMPI] Tokenizando tarjeta...");
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
            { headers: { Authorization: `Bearer ${WOMPI_PUBLIC_KEY}` } }
        );
        return response.data.data;
    } catch (err: any) {
        console.error("❌ Error tokenizando tarjeta:", err.response?.data || err.message);
        throw err;
    }
}

/* ============================================================
   3) Crear Fuente de Pago Permanente (Vault)
============================================================ */
export async function createPaymentSourceVault(data: {
    token: string;
    customerEmail: string;
    deviceFingerprint: string;
}) {
    console.log("💳 [WOMPI] Creando Fuente de Pago Permanente...");
    const acceptance_token = await getAcceptanceToken();

    const body = {
        type: "CARD",
        token: data.token,
        acceptance_token,
        device_fingerprint: data.deviceFingerprint,
        customer_email: data.customerEmail,
    };

    try {
        const res = await axios.post(
            `${WOMPI_BASE_URL}/payment_sources`,
            body,
            { headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` } }
        );
        const source = res.data?.data;
        console.log("✅ Payment source creado ID:", source?.id);
        return source;
    } catch (err: any) {
        console.error("❌ Error creando Payment Source:", err.response?.data || err.message);
        throw err;
    }
}

/* ============================================================
   4) Cobro con Token (Legacy)
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
    const amount = Math.trunc(amountInCents);
    const signaturePlain = `${reference}${amount}${currency}${WOMPI_INTEGRITY_KEY}`;
    const signature = crypto.createHash("sha256").update(signaturePlain).digest("hex");
    const acceptance_token = await getAcceptanceToken();

    const body = {
        amount_in_cents: amount,
        currency,
        customer_email: customerEmail,
        reference,
        payment_method: { type: "CARD", token, installments: 1 },
        signature,
        acceptance_token,
    };

    try {
        const response = await axios.post(`${WOMPI_BASE_URL}/transactions`, body, {
            headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` },
        });
        return response.data;
    } catch (err: any) {
        console.error("❌ Error cobro token:", err.response?.data || err.message);
        throw err;
    }
}

/* ============================================================
   5) Cobro con Payment Source (REUTILIZABLE) - ✅ FIX REAL
============================================================ */
export async function chargeWithPaymentSource({
    paymentSourceId,
    amountInCents,
    currency = "COP",
    customerEmail,
    reference,
}: {
    paymentSourceId: string;
    amountInCents: number;
    currency?: string;
    customerEmail: string;
    reference: string;
}) {
    const amount = Math.trunc(amountInCents);
    const signaturePlain = `${reference}${amount}${currency}${WOMPI_INTEGRITY_KEY}`;
    const signature = crypto.createHash("sha256").update(signaturePlain).digest("hex");
    const acceptance_token = await getAcceptanceToken();

    console.log(`💸 [WOMPI] Cobrando con Fuente ID: ${paymentSourceId} | Monto: ${amount}`);

    const body = {
        amount_in_cents: amount,
        currency,
        customer_email: customerEmail,
        reference,
        payment_method: {
            type: "CARD",
            // 🛑 ANTES (Error): payment_source_id: Number(paymentSourceId)
            // ✅ AHORA (Correcto): La llave DEBE ser "token", y el valor es el ID de la fuente.
            token: paymentSourceId.toString(),
            installments: 1,
        },
        signature,
        acceptance_token,
    };

    try {
        const response = await axios.post(`${WOMPI_BASE_URL}/transactions`, body, {
            headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` },
        });
        return response.data;
    } catch (err: any) {
        // Mejoramos el log para ver el error completo de Wompi si vuelve a pasar
        console.error("❌ Error cobro payment source:", JSON.stringify(err.response?.data, null, 2));
        throw err;
    }
}
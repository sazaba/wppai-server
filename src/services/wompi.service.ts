// src/services/wompi.service.ts
import axios from "axios";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL =
    process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";

// Cache en memoria del acceptance_token
let acceptanceTokenCache: string | null = null;

/**
 * Obtiene (y cachea) el acceptance_token del comercio
 */
export async function getAcceptanceToken(): Promise<string> {
    if (acceptanceTokenCache) return acceptanceTokenCache;

    const res = await axios.get(
        `${WOMPI_BASE_URL}/merchants/${WOMPI_PUBLIC_KEY}`
    );

    const token = res.data?.data?.presigned_acceptance?.acceptance_token;
    if (!token) {
        throw new Error("No se pudo obtener el acceptance_token de Wompi");
    }

    acceptanceTokenCache = token;
    return token;
}

/**
 * Crea un token de tarjeta (tok_test_...)
 */
export async function createPaymentSource(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
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

    return response.data.data; // token Wompi
}

/**
 * Cobra una transacción usando el token de tarjeta
 * (pagos tokenizados → SIN signature, solo acceptance_token)
 */
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
    const acceptance_token = await getAcceptanceToken();

    // Aseguramos que sea entero en centavos
    const amount = Math.trunc(amountInCents);

    console.log("WOMPI charge debug =>", {
        amount,
        currency,
        reference,
        acceptance_token,
        info: "TOKENIZED CARD PAYMENT · SIN signature",
    });

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
            // ⛔️ SIN signature
        },
        {
            headers: {
                Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            },
        }
    );

    return response.data;
}

// src/services/wompi.service.ts
import axios from "axios";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_BASE_URL = process.env.WOMPI_BASE_URL || "https://sandbox.wompi.co/v1";

// Cache en memoria del acceptance_token para no pedirlo en cada request
let acceptanceTokenCache: string | null = null;

/**
 * Obtiene (y cachea) el acceptance_token de Wompi para tu comercio.
 * Funciona igual en sandbox y en producción, solo cambia WOMPI_BASE_URL y las llaves.
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

    const response = await axios.post(
        `${WOMPI_BASE_URL}/transactions`,
        {
            amount_in_cents: amountInCents,
            currency,
            customer_email: customerEmail,
            reference,
            payment_method: {
                type: "CARD",
                token,
                installments: 1,
            },
            acceptance_token, // 👈 ahora siempre lo mandamos desde aquí
        },
        {
            headers: {
                Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            },
        }
    );

    return response.data;
}

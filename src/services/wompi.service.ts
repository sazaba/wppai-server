// src/services/wompi.service.ts
import axios from "axios";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;

// 👇 Unificamos para sandbox y producción
// En .env local y en Render:
//   WOMPI_BASE_URL=https://sandbox.wompi.co/v1
// En producción:
//   WOMPI_BASE_URL=https://production.wompi.co/v1
const WOMPI_BASE_URL = process.env.WOMPI_BASE_URL ?? "https://sandbox.wompi.co/v1";

/* =======================================================
   Cache de acceptance_token
======================================================= */

let acceptanceCache: { token: string; fetchedAt: number } | null = null;
// Puedes cambiar el TTL, 12 horas es bastante seguro
const ACCEPTANCE_TTL_MS = 1000 * 60 * 60 * 12;

/**
 * Obtiene el acceptance_token desde Wompi y lo cachea en memoria.
 * Funciona igual en sandbox y producción, usando WOMPI_BASE_URL + PUBLIC_KEY.
 */
async function getAcceptanceToken(): Promise<string> {
    const now = Date.now();

    if (
        acceptanceCache &&
        now - acceptanceCache.fetchedAt < ACCEPTANCE_TTL_MS
    ) {
        return acceptanceCache.token;
    }

    const url = `${WOMPI_BASE_URL.replace(/\/v1$/, "")}/v1/merchants/${WOMPI_PUBLIC_KEY}`;

    const res = await axios.get(url);
    const token =
        res.data?.data?.presigned_acceptance?.acceptance_token as string | undefined;

    if (!token) {
        throw new Error("No se pudo obtener acceptance_token desde Wompi");
    }

    acceptanceCache = { token, fetchedAt: now };
    return token;
}

/* =======================================================
   Crear token de tarjeta (payment source)
======================================================= */

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

    return response.data.data; // retorna token
}

/* =======================================================
   Cobrar usando token de tarjeta
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
    // 👇 obtenemos automáticamente el acceptance_token correcto
    const acceptance_token = await getAcceptanceToken();

    const response = await axios.post(
        `${WOMPI_BASE_URL}/transactions`,
        {
            amount_in_cents: amountInCents,
            currency,
            customer_email: customerEmail,
            acceptance_token, // 👈 obligatorio para Wompi
            payment_method: {
                type: "CARD",
                token,
                installments: 1,
            },
            reference,
        },
        {
            headers: {
                Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            },
        }
    );

    return response.data;
}

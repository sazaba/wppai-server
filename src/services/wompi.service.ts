// src/services/wompi.service.ts
import axios from "axios";

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY!;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY!;
const WOMPI_SANDBOX_URL = "https://sandbox.wompi.co/v1";

export async function createPaymentSource(cardData: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
}) {
    const response = await axios.post(
        `${WOMPI_SANDBOX_URL}/tokens/cards`,
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
    const response = await axios.post(
        `${WOMPI_SANDBOX_URL}/transactions`,
        {
            amount_in_cents: amountInCents,
            currency,
            customer_email: customerEmail,
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

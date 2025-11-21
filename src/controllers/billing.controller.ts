// src/controllers/billing.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import * as Wompi from "../services/wompi.service";
import { getEmpresaId } from "./_getEmpresaId";

/* =======================================================
   Helpers internos
======================================================= */

// Obtiene un plan por código o lanza error
async function getPlanOrThrow(code: "basic" | "pro") {
    const plan = await prisma.subscriptionPlan.findUnique({
        where: { code },
    });

    if (!plan) {
        throw new Error(`No existe plan ${code}`);
    }

    return plan;
}

// Crea o reutiliza la suscripción para el plan indicado
async function createOrUpdateSubscriptionForPlan(
    empresaId: number,
    planCode: "basic" | "pro"
) {
    const plan = await getPlanOrThrow(planCode);

    let subscription = await prisma.subscription.findFirst({
        where: { empresaId },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
    });

    if (subscription) {
        if (subscription.planId !== plan.id) {
            // upgrade / downgrade
            subscription = await prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    planId: plan.id,
                    status: "active",
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                },
                include: { plan: true },
            });
        } else {
            // mismo plan, asegurar active
            subscription = await prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    status: "active",
                    cancelAtPeriodEnd: false,
                },
                include: { plan: true },
            });
        }
    } else {
        const now = new Date();
        const nextMonth = new Date(now);
        nextMonth.setMonth(now.getMonth() + 1);

        subscription = await prisma.subscription.create({
            data: {
                empresaId,
                planId: plan.id,
                currentPeriodStart: now,
                currentPeriodEnd: nextMonth,
            },
            include: { plan: true },
        });
    }

    return { subscription, plan };
}

// Actualiza el plan de la empresa SOLO cuando hay pago aprobado
async function syncEmpresaPlanWithSubscription(
    empresaId: number,
    planCode: "basic" | "pro"
) {
    await prisma.empresa.update({
        where: { id: empresaId },
        data: {
            plan: planCode,
            estado: "activo",
        },
    });
}

/* =======================================================
   1) Crear / cambiar método de pago (3DS → Payment Source)
======================================================= */

export const createPaymentMethod = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const {
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
            email,
            deviceFingerprint,
        } = req.body;

        if (!deviceFingerprint) {
            return res.status(400).json({
                ok: false,
                error: "DEVICE_FINGERPRINT_REQUIRED",
            });
        }

        // 1. Crear payment source en Wompi (3DS)
        const source = await Wompi.createPaymentSource3DS({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
            deviceFingerprint,
            customerEmail: email,
        });

        // 2. Marcar métodos anteriores como no default
        await prisma.paymentMethod.updateMany({
            where: { empresaId },
            data: { isDefault: false },
        });

        // 3. Datos auxiliares
        const lastFour =
            typeof number === "string" && number.length >= 4
                ? number.slice(-4)
                : null;

        const brand =
            (source as any)?.token?.brand ||
            (source as any)?.payment_method?.extra?.brand ||
            null;

        // 4. Guardar método de pago apuntando al payment_source
        const payment = await prisma.paymentMethod.create({
            data: {
                empresaId,
                wompiSourceId: source.id,
                wompiToken: null, // ya no usamos token directo
                brand,
                lastFour,
                expMonth: exp_month,
                expYear: exp_year,
                isDefault: true,
                cardHolder: card_holder,
                email: email || null,
                status: source.status ?? null,
            },
        });

        return res.json({
            ok: true,
            paymentMethod: payment,
            wompiSource: {
                id: source.id,
                status: source.status,
                redirect_url: source.redirect_url,
            },
        });
    } catch (error: any) {
        console.error("🔥 ERROR en createPaymentMethod() ------------------");
        console.error("Mensaje:", error.message);

        if (error.response) {
            console.error("Status Wompi:", error.response.status);
            console.error("Data Wompi:", error.response.data);
        } else {
            console.error("Error sin response:", error);
        }

        return res.status(500).json({
            ok: false,
            error: "WOMPI_ERROR",
            details: error.response?.data || error.message,
        });
    }
};

/* =======================================================
   2) Eliminar método de pago por defecto
======================================================= */

export const deletePaymentMethod = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const pm = await prisma.paymentMethod.findFirst({
            where: { empresaId, isDefault: true },
        });

        if (!pm) {
            return res
                .status(404)
                .json({ ok: false, error: "No hay método de pago para eliminar" });
        }

        // Romper referencia en pagos históricos
        await prisma.subscriptionPayment.updateMany({
            where: { paymentMethodId: pm.id },
            data: { paymentMethodId: null },
        });

        await prisma.paymentMethod.delete({
            where: { id: pm.id },
        });

        return res.json({ ok: true });
    } catch (error: any) {
        console.error("Error eliminando método de pago:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Error eliminando método de pago",
        });
    }
};

/* =======================================================
   3) Crear / actualizar suscripción BASIC
======================================================= */

export const createSubscriptionBasic = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const { subscription, plan } = await createOrUpdateSubscriptionForPlan(
            empresaId,
            "basic"
        );

        return res.json({
            ok: true,
            subscription,
            plan,
        });
    } catch (error: any) {
        console.error("Error creando suscripción BASIC:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Error creando suscripción BASIC",
        });
    }
};

/* =======================================================
   4) Cobrar suscripción (usa CARD_PAYMENT_SOURCE)
======================================================= */

export const chargeSubscription = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 },
                subscriptions: {
                    where: { status: "active" },
                    take: 1,
                    orderBy: { createdAt: "desc" },
                    include: { plan: true },
                },
            },
        });

        if (
            !empresa ||
            !empresa.subscriptions.length ||
            !empresa.paymentMethods.length
        ) {
            return res
                .status(400)
                .json({ ok: false, error: "Sin suscripción o método de pago" });
        }

        const subscription = empresa.subscriptions[0];
        const pm = empresa.paymentMethods[0];

        if (!pm.wompiSourceId) {
            return res.status(400).json({
                ok: false,
                error: "Método de pago sin payment_source_id (wompiSourceId)",
            });
        }

        // 🔹 Buscar email en la tabla usuario (primer usuario de esa empresa)
        const usuarioBilling = await prisma.usuario.findFirst({
            where: { empresaId },
        });

        const customerEmail =
            pm.email || usuarioBilling?.email || "cliente@example.com";

        // Monto en centavos (price viene en unidades monetarias)
        const amountInCents = Math.round(Number(subscription.plan.price) * 100);
        const reference = `sub_${subscription.id}_${Date.now()}`;

        const wompiResp = await Wompi.chargeWithPaymentSource({
            paymentSourceId: pm.wompiSourceId,
            amountInCents,
            customerEmail,
            reference,
        });

        const wompiData = wompiResp?.data ?? wompiResp;
        const isApproved = wompiData.status === "APPROVED";

        const paymentRecord = await prisma.subscriptionPayment.create({
            data: {
                empresaId,
                subscriptionId: subscription.id,
                paymentMethodId: pm.id,
                amount: subscription.plan.price,
                wompiTransactionId: wompiData.id,
                status: isApproved ? "paid" : "pending",
                paidAt: isApproved ? new Date() : null,
                errorMessage: isApproved ? null : JSON.stringify(wompiData),
            },
        });

        if (isApproved) {
            const now = new Date();
            const nextMonth = new Date(now);
            nextMonth.setMonth(now.getMonth() + 1);

            await prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    currentPeriodStart: now,
                    currentPeriodEnd: nextMonth,
                    status: "active",
                },
            });

            const newPlanCode = subscription.plan.code as "basic" | "pro";
            await syncEmpresaPlanWithSubscription(empresaId, newPlanCode);
        }

        return res.json({
            ok: isApproved,
            payment: paymentRecord,
            wompi: wompiData,
        });
    } catch (error: any) {
        console.error(
            "Error cobrando suscripción:",
            error?.response?.data || error.message || error
        );
        return res
            .status(500)
            .json({ ok: false, error: "Error cobrando suscripción" });
    }
};

/* =======================================================
   5) Dashboard de Billing (estado general)
======================================================= */

export const getBillingStatus = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 },
                subscriptions: {
                    where: { status: "active" },
                    take: 1,
                    orderBy: { createdAt: "desc" },
                    include: { plan: true },
                },
                subscriptionPayments: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                },
            },
        });

        const subscription = empresa?.subscriptions[0] || null;

        return res.json({
            ok: true,
            paymentMethod: empresa?.paymentMethods[0] || null,
            subscription,
            payments: empresa?.subscriptionPayments || [],
            empresaPlan: empresa?.plan || "gratis",
            empresaEstado: empresa?.estado || null,
            nextBillingDate: subscription?.currentPeriodEnd || null,
        });
    } catch (err: any) {
        console.error("Error cargando estado de billing:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

/* =======================================================
   6) Webhook de Wompi (payment_source.updated, etc.)
======================================================= */

export const handleWompiWebhook = async (req: Request, res: Response) => {
    try {
        const body = req.body as any;
        const event = body?.event;
        const data = body?.data;

        console.log("📩 [WOMPI WEBHOOK] Evento recibido:", event);

        if (!event || !data) {
            return res.status(400).json({ ok: false, error: "Payload inválido" });
        }

        // 🔹 Cuando el medio de pago queda listo para usarse
        if (event === "payment_source.updated") {
            const sourceId = data.id;
            const status = data.status;

            console.log("🔄 payment_source.updated:", { sourceId, status });

            await prisma.paymentMethod.updateMany({
                where: { wompiSourceId: sourceId },
                data: {
                    status,
                    // si quieres: marcarlo default al quedar AVAILABLE
                    isDefault: status === "AVAILABLE" ? true : undefined,
                },
            });
        }

        // Aquí podrías manejar también transaction.updated, etc.
        // if (event === "transaction.updated") { ... }

        return res.json({ ok: true });
    } catch (err: any) {
        console.error("❌ Error procesando webhook de Wompi:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

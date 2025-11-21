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
// - Si hay suscripción existente, actualiza planId (upgrade / downgrade)
// - Si no hay, la crea con un periodo inicial (luego lo ajusta el cobro)
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
   1) Crear / cambiar método de pago (tarjeta → token Wompi)
======================================================= */

export const createPaymentMethod = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const { number, cvc, exp_month, exp_year, card_holder } = req.body;

        // 1. Crear token en Wompi (tarjeta → tok_test_xxx)
        const tokenData = await Wompi.createPaymentSource({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
        });

        // 2. Marcar métodos anteriores como no default (solo 1 default)
        await prisma.paymentMethod.updateMany({
            where: { empresaId },
            data: { isDefault: false },
        });

        // 3. Guardar nuevo método de pago como default
        const payment = await prisma.paymentMethod.create({
            data: {
                empresaId,
                wompiToken: tokenData.id,
                brand: tokenData.brand,
                lastFour: tokenData.last_four,
                expMonth: exp_month,
                expYear: exp_year,
                isDefault: true,
            },
        });

        return res.json({
            ok: true,
            paymentMethod: payment,
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
   (solo prepara la suscripción; el cambio de plan se hace al pagar)
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
   4) Cobrar suscripción
======================================================= */

// src/controllers/billing.controller.ts

// dentro de src/controllers/billing.controller.ts

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

        const amountInCents = Number(subscription.plan.price); // SIN * 100


        // 👉 YA NO PASAMOS acceptanceToken, lo resuelve internamente wompi.service
        const wompiResp = await Wompi.chargeWithToken({
            token: pm.wompiToken,
            amountInCents,
            customerEmail: "cliente@example.com", // luego lo cambiamos por el real
            reference: `sub_${subscription.id}_${Date.now()}`,
        });

        const wompiData = wompiResp.data;
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
            wompi: wompiResp,
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

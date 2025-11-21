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
// - Si no hay, la crea con un periodo inicial (lo afinamos al cobrar)
async function createOrUpdateSubscriptionForPlan(empresaId: number, planCode: "basic" | "pro") {
    const plan = await getPlanOrThrow(planCode);

    // Tomamos la última suscripción creada para esta empresa
    let subscription = await prisma.subscription.findFirst({
        where: { empresaId },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
    });

    if (subscription) {
        // Upgrade / downgrade si el plan es distinto
        if (subscription.planId !== plan.id) {
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
            // Mantenemos el mismo plan, nos aseguramos de que esté "active"
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
        // No existía suscripción, la creamos
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
async function syncEmpresaPlanWithSubscription(empresaId: number, planCode: "basic" | "pro") {
    // Asumimos que en Empresa.plan existen valores: 'gratis' | 'basic' | 'pro'
    await prisma.empresa.update({
        where: { id: empresaId },
        data: {
            plan: planCode,
            estado: "activo",
        },
    });
}

/* =======================================================
   1) Crear método de pago (tarjeta → token Wompi)
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
        } = req.body;

        // 1. Crear token en Wompi (tarjeta → tok_test_xxx)
        const tokenData = await Wompi.createPaymentSource({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
        });

        // 2. Guardar método de pago en nuestra BD
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
   2) Crear / actualizar suscripción para PLAN BASIC
   (solo prepara la suscripción; NO cambia el plan de la empresa)
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
   3) Cobrar suscripción (usa método de pago por defecto)
   - Cobra el monto del plan actual de la suscripción
   - Registra SubscriptionPayment
   - SOLO si Wompi responde APPROVED:
       • Marca el pago como "paid" + paidAt
       • Actualiza currentPeriodStart/End de la suscripción
       • Cambia empresa.plan → basic/pro y estado → activo
======================================================= */

export const chargeSubscription = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 },
                subscriptions: {
                    // usamos la última suscripción "activa"
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

        const amountInCents = Number(subscription.plan.price) * 100;

        // 1. Cobro en Wompi
        const wompiResp = await Wompi.chargeWithToken({
            token: pm.wompiToken,
            amountInCents,
            customerEmail: "cliente@example.com", // luego lo cambiamos por el real
            reference: `sub_${subscription.id}_${Date.now()}`,
        });

        const wompiData = wompiResp.data;
        const isApproved = wompiData.status === "APPROVED";

        // 2. Registrar pago
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

        // 3. Si está aprobado → actualizamos periodo y plan de la empresa
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

            // Plan de la empresa: gratis → basic/pro, upgrade, downgrade
            const newPlanCode = subscription.plan.code as "basic" | "pro";
            await syncEmpresaPlanWithSubscription(empresaId, newPlanCode);
        }

        return res.json({
            ok: isApproved,
            payment: paymentRecord,
            wompi: wompiResp,
        });
    } catch (error: any) {
        console.error("Error cobrando suscripción:", error?.response?.data || error.message || error);
        return res
            .status(500)
            .json({ ok: false, error: "Error cobrando suscripción" });
    }
};

/* =======================================================
   4) Dashboard de Billing (estado general)
   - Método de pago por defecto
   - Suscripción activa
   - Últimos pagos
   - Plan actual de la empresa y siguiente fecha de cobro
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
            // Extra para el dashboard:
            empresaPlan: empresa?.plan || "gratis",
            empresaEstado: empresa?.estado || null,
            nextBillingDate: subscription?.currentPeriodEnd || null,
        });
    } catch (err: any) {
        console.error("Error cargando estado de billing:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

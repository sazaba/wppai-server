// src/controllers/billing.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import * as Wompi from "../services/wompi.service";
import { getEmpresaId } from "./_getEmpresaId";

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

        // 1. Crear token en Wompi
        const tokenData = await Wompi.createPaymentSource({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
        });

        // 2. Guardar método de pago
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
        console.error(
            "Error creando método de pago:",
            error?.response?.data || error.message || error
        );
        return res.status(500).json({ ok: false, error: "Error creando método de pago" });
    }

};

export const createSubscriptionBasic = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);


        const plan = await prisma.subscriptionPlan.findUnique({
            where: { code: "basic" },
        });

        if (!plan) {
            return res.status(400).json({ ok: false, error: "No existe plan basic" });
        }

        const now = new Date();
        const nextMonth = new Date();
        nextMonth.setMonth(now.getMonth() + 1);

        const subscription = await prisma.subscription.create({
            data: {
                empresaId,
                planId: plan.id,
                currentPeriodStart: now,
                currentPeriodEnd: nextMonth,
            },
        });

        await prisma.empresa.update({
            where: { id: empresaId },
            data: { plan: "basic", estado: "activo" },
        });

        return res.json({ ok: true, subscription });
    } catch (error: any) {
        console.error(
            "Error creando suscripción:",
            error?.response?.data || error.message || error
        );
        res.status(500).json({ ok: false, error: "Error creando suscripción" });
    }

};

export const chargeSubscription = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 },
                subscriptions: { where: { status: "active" }, take: 1, include: { plan: true } },
            },
        });

        if (!empresa || !empresa.subscriptions.length || !empresa.paymentMethods.length) {
            return res.status(400).json({ ok: false, error: "Sin suscripción o método de pago" });
        }

        const subscription = empresa.subscriptions[0];
        const pm = empresa.paymentMethods[0];

        const amountInCents = Number(subscription.plan.price) * 100;

        // 1. Cobro en Wompi
        const wompiResp = await Wompi.chargeWithToken({
            token: pm.wompiToken,
            amountInCents,
            customerEmail: "cliente@example.com", // TODO: puedes agregar email real
            reference: `sub_${subscription.id}_${Date.now()}`,
        });

        // 2. Registrar pago
        const record = await prisma.subscriptionPayment.create({
            data: {
                empresaId,
                subscriptionId: subscription.id,
                paymentMethodId: pm.id,
                amount: subscription.plan.price,
                wompiTransactionId: wompiResp.data.id,
                status: wompiResp.data.status === "APPROVED" ? "paid" : "pending",
            },
        });

        return res.json({ ok: true, payment: record, wompi: wompiResp });
    } catch (error: any) {
        console.error(
            "Error cobrando suscripción:",
            error?.response?.data || error.message || error
        );
        res.status(500).json({ ok: false, error: "Error cobrando suscripción" });
    }

};


// src/controllers/billing.controller.ts
import { Request, Response } from "express";
import prisma from "../lib/prisma";
import * as Wompi from "../services/wompi.service";
import { getEmpresaId } from "./_getEmpresaId";
import { SubscriptionPlan } from "@prisma/client"; // Necesario para leer tipos del plan

/* =======================================================
   💰 CONFIGURACIÓN DE PAQUETES EXTRA (Top-ups)
   Precios en Pesos Colombianos (COP).
   Esto permite comprar 300 o 600 créditos adicionales.
======================================================= */
const CREDIT_PACKAGES: Record<number, number> = {
    300: 1800,  // 300 conversaciones por $50.000
    600: 1900,  // 600 conversaciones por $90.000 (Descuento)
};

/* =======================================================
   📅 HELPERS DE FECHA
======================================================= */

function addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
}

/**
 * Calcula la renovación usando los días de gracia dinámicos del plan.
 */
function calculateRenewalPeriod(currentEnd: Date, now: Date, graceDays: number) {
    const graceLimit = addDays(currentEnd, graceDays);
    // Si pagan dentro del periodo de gracia, se respeta la fecha de corte original.
    // Si pagan después, el nuevo mes arranca hoy.
    const baseStart = now <= graceLimit ? currentEnd : now;

    const newStart = addDays(baseStart, 1);
    const newEnd = addMonths(newStart, 1);

    return { newStart, newEnd };
}

/* =======================================================
   ⚙️ HELPERS INTERNOS (Base de Datos)
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

/**
 * ✨ ACTUALIZADO: Sincroniza el plan y REINICIA los límites de conversación.
 * Esta función reemplaza a la antigua 'syncEmpresaPlanWithSubscription'.
 * Se llama cuando se aprueba el pago de una mensualidad.
 */
async function syncEmpresaPlanAndLimits(
    empresaId: number,
    plan: SubscriptionPlan
) {
    await prisma.empresa.update({
        where: { id: empresaId },
        data: {
            plan: plan.code as any, // "basic" | "pro"
            estado: "activo",

            // ✨ LÓGICA DE RESETEO MENSUAL
            monthlyConversationLimit: plan.monthlyCredits, // Ej: Vuelve a 300
            conversationsUsed: 0,                          // Consumo vuelve a 0
            conversationsCycleStart: new Date(),           // Nuevo ciclo
        },
    });
}

/* =======================================================
   1) Crear / cambiar método de pago (TOKEN ÚNICO)
======================================================= */
export const createPaymentMethod = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const { number, cvc, exp_month, exp_year, card_holder, email, deviceFingerprint } = req.body;

        if (!deviceFingerprint) return res.status(400).json({ ok: false, error: "DEVICE_FINGERPRINT_REQUIRED" });
        if (!number || !cvc || !email) return res.status(400).json({ ok: false, error: "DATA_INCOMPLETE" });

        // ✨ CAMBIO: Creamos una Fuente de Pago (Vault) en lugar de solo un token
        // Esto consume el token temporal internamente y nos devuelve un ID permanente
        const { source, cardToken } = await Wompi.createPaymentSource3DS({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
            deviceFingerprint,
            customerEmail: email
        });

        // Desactivar defaults anteriores
        await prisma.paymentMethod.updateMany({
            where: { empresaId },
            data: { isDefault: false },
        });

        // Guardamos el ID de la fuente en wompiToken (para compatibilidad de esquema)
        // Este ID (ej: 23423) es el que usaremos para cobrar siempre
        const payment = await prisma.paymentMethod.create({
            data: {
                empresaId,
                wompiSourceId: String(source.id),
                wompiToken: String(source.id), // 👈 Guardamos el ID Permanente aquí
                brand: cardToken.brand,
                lastFour: cardToken.last_four,
                expMonth: exp_month,
                expYear: exp_year,
                isDefault: true,
                cardHolder: card_holder,
                email: email,
                status: source.status, // AVAILABLE, PENDING...
            },
        });

        return res.json({
            ok: true,
            paymentMethod: payment,
            wompiSource: source // Devolvemos info de la fuente para redirección si aplica
        });
    } catch (error: any) {
        console.error("🔥 Error createPaymentMethod:", error);
        return res.status(500).json({ ok: false, error: "WOMPI_ERROR", details: error.message });
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
   3) Crear / actualizar suscripción BASIC / PRO
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

export const createSubscriptionPro = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const { subscription, plan } = await createOrUpdateSubscriptionForPlan(
            empresaId,
            "pro"
        );
        return res.json({
            ok: true,
            subscription,
            plan,
        });
    } catch (error: any) {
        console.error("Error creando suscripción PRO:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Error creando suscripción PRO",
        });
    }
};

/* =======================================================
   4) Cobrar suscripción (Renovación Mensual)
======================================================= */

export const chargeSubscription = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        // ... (búsqueda de empresa y validaciones igual que antes) ...
        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 },
                subscriptions: { where: { status: "active" }, take: 1, orderBy: { createdAt: "desc" }, include: { plan: true } },
            },
        });

        if (!empresa || !empresa.subscriptions.length || !empresa.paymentMethods.length) {
            return res.status(400).json({ ok: false, error: "Sin suscripción o método de pago" });
        }

        const subscription = empresa.subscriptions[0];
        const pm = empresa.paymentMethods[0];
        const usuarioBilling = await prisma.usuario.findFirst({ where: { empresaId } });
        const customerEmail = pm.email || usuarioBilling?.email || "cliente@example.com";

        const amountInCents = Math.round(Number(subscription.plan.price) * 100);
        const reference = `sub_${subscription.id}_${Date.now()}`;

        // ✨ CAMBIO: Usamos chargeWithPaymentSource
        // pm.wompiToken ahora contiene el ID de la fuente (ej. "2045")
        const wompiResp = await Wompi.chargeWithPaymentSource({
            paymentSourceId: pm.wompiToken!,
            amountInCents,
            customerEmail,
            reference,
        });

        // ... (Resto de la lógica de respuesta y actualización de DB igual que antes) ...
        const wompiData = wompiResp?.data ?? wompiResp;
        // ... guardar pago, actualizar suscripción, etc ...
        const isApproved = wompiData.status === "APPROVED";
        const isPending = wompiData.status === "PENDING";

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
            const { newStart, newEnd } = calculateRenewalPeriod(subscription.currentPeriodEnd, now, subscription.plan.gracePeriodDays);
            await prisma.subscription.update({
                where: { id: subscription.id },
                data: { currentPeriodStart: newStart, currentPeriodEnd: newEnd, status: "active" },
            });
            await syncEmpresaPlanAndLimits(empresaId, subscription.plan);
        }

        return res.json({ ok: isApproved || isPending, message: isApproved ? "Aprobado" : "Pendiente", payment: paymentRecord, wompi: wompiData });

    } catch (error: any) {
        console.error("Error cobrando:", error);
        return res.status(500).json({ ok: false, error: "Error de cobro" });
    }
};
/* =======================================================
   ✨ 5) COMPRA DE CRÉDITOS EXTRA (Top-ups)
   Nueva funcionalidad para comprar 300 o 600 conversaciones
======================================================= */

export const purchaseConversationCredits = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const { amount } = req.body;
        const priceCOP = CREDIT_PACKAGES[Number(amount)];
        if (!priceCOP) return res.status(400).json({ ok: false, error: "Paquete inválido" });

        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: { paymentMethods: { where: { isDefault: true }, take: 1 } }
        });
        const pm = empresa?.paymentMethods[0];
        if (!pm || !pm.wompiToken) return res.status(400).json({ ok: false, error: "No tienes método de pago" });

        const usuarioBilling = await prisma.usuario.findFirst({ where: { empresaId } });
        const customerEmail = pm.email || usuarioBilling?.email || "cliente@example.com";
        const amountInCents = priceCOP * 100;
        const reference = `topup_${empresaId}_${Date.now()}`;

        // ✨ CAMBIO: Usamos chargeWithPaymentSource
        const wompiResp = await Wompi.chargeWithPaymentSource({
            paymentSourceId: pm.wompiToken,
            amountInCents,
            customerEmail,
            reference,
        });

        const wompiData = wompiResp?.data ?? wompiResp;
        const isApproved = wompiData.status === "APPROVED";

        // ... (Resto igual: guardar compra, actualizar límites) ...
        const purchase = await prisma.conversationPurchase.create({
            data: {
                empresaId,
                creditsAmount: Number(amount),
                pricePaid: priceCOP,
                wompiTransactionId: wompiData.id,
                status: isApproved ? "paid" : "pending",
                isApplied: isApproved,
                appliedAt: isApproved ? new Date() : null,
                errorMessage: isApproved ? null : JSON.stringify(wompiData),
            }
        });

        if (isApproved) {
            await prisma.empresa.update({
                where: { id: empresaId },
                data: { monthlyConversationLimit: { increment: Number(amount) } }
            });
        }

        return res.json({ ok: isApproved || wompiData.status === "PENDING", message: "Procesado", purchase, wompi: wompiData });

    } catch (error: any) {
        console.error("Error comprando créditos:", error);
        return res.status(500).json({ ok: false, error: error.message });
    }
};

/* =======================================================
   6) Dashboard de Billing (estado general)
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
                conversationPurchases: {
                    orderBy: { createdAt: "desc" },
                    take: 5
                }
            },
        });

        const subscription = empresa?.subscriptions[0] || null;

        // Variables de estado
        let daysLeft: number | null = null;
        let isInGrace = false;
        let isActiveForUse = false;
        let isTrial = false; // ✨ Bandera para saber si es modo prueba
        const graceDaysPlan = subscription?.plan?.gracePeriodDays ?? 2;

        const now = new Date();

        if (subscription) {
            // === CASO 1: TIENE SUSCRIPCIÓN ===
            const end = subscription.currentPeriodEnd;
            const diffMs = end.getTime() - now.getTime();
            daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

            const graceLimit = addDays(end, graceDaysPlan);
            isInGrace = daysLeft < 0 && now <= graceLimit;
            isActiveForUse = now <= graceLimit;
        } else {
            // === CASO 2: MODO TRIAL (GRATIS) ===
            // Si no hay suscripción, miramos el trialEnd de la empresa
            if (empresa?.trialEnd) {
                isTrial = true;
                const end = empresa.trialEnd;
                const diffMs = end.getTime() - now.getTime();
                daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                // En trial no hay "periodo de gracia" de pago, simplemente se acaba.
                // Se considera activo si aún quedan días (o es el mismo día 0).
                isActiveForUse = daysLeft >= 0;
            }
        }

        return res.json({
            ok: true,
            paymentMethod: empresa?.paymentMethods[0] || null,
            subscription,
            payments: empresa?.subscriptionPayments || [],
            conversationPurchases: empresa?.conversationPurchases || [],

            empresaPlan: empresa?.plan || "gratis",
            empresaEstado: empresa?.estado || null,

            usage: {
                used: empresa?.conversationsUsed || 0,
                limit: empresa?.monthlyConversationLimit || 0,
            },

            nextBillingDate: subscription?.currentPeriodEnd || empresa?.trialEnd || null,

            meta: {
                daysLeft,
                isInGrace,
                isActiveForUse,
                graceDays: graceDaysPlan,
                isTrial, // ✨ Enviamos esto al front para cambiar el texto del banner
            },
        });

    } catch (err: any) {
        console.error("Error cargando estado de billing:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
/* =======================================================
   7) Webhook de Wompi (Inteligente)
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

        // 1) Actualizar método de pago
        if (event === "payment_source.updated") {
            const sourceId = data.id;
            const status = data.status;

            console.log("🔄 payment_source.updated:", { sourceId, status });

            await prisma.paymentMethod.updateMany({
                where: { wompiSourceId: String(sourceId) },
                data: {
                    status,
                    isDefault: status === "AVAILABLE" ? true : undefined,
                },
            });
            return res.json({ ok: true });
        }

        // 2) Actualizar transacción
        if (event === "transaction.updated") {
            const txId = data?.id || data?.transaction?.id;
            const txStatus = data?.status || data?.transaction?.status;

            console.log("🔄 transaction.updated:", { txId, txStatus });

            if (!txId || !txStatus) return res.json({ ok: false, ignored: "invalid_payload" });

            const isApproved = txStatus === "APPROVED";

            // --- CASO A: Es una Suscripción ---
            const subPayment = await prisma.subscriptionPayment.findFirst({
                where: { wompiTransactionId: txId },
                include: { subscription: { include: { plan: true } } },
            });

            if (subPayment) {
                await prisma.subscriptionPayment.update({
                    where: { id: subPayment.id },
                    data: {
                        status: isApproved ? "paid" : "pending",
                        paidAt: isApproved ? new Date() : null,
                        errorMessage: isApproved ? null : JSON.stringify(data),
                    },
                });

                if (isApproved && subPayment.subscription) {
                    const now = new Date();
                    const { newStart, newEnd } = calculateRenewalPeriod(
                        subPayment.subscription.currentPeriodEnd,
                        now,
                        subPayment.subscription.plan.gracePeriodDays
                    );

                    await prisma.subscription.update({
                        where: { id: subPayment.subscriptionId },
                        data: {
                            currentPeriodStart: newStart,
                            currentPeriodEnd: newEnd,
                            status: "active",
                        },
                    });

                    // ✨ Reiniciar contadores (Reseteo mensual)
                    await syncEmpresaPlanAndLimits(subPayment.empresaId, subPayment.subscription.plan);
                }
                return res.json({ ok: true, type: "subscription" });
            }

            // --- CASO B: Es una Compra de Créditos (Top-up) ---
            const creditPurchase = await prisma.conversationPurchase.findFirst({
                where: { wompiTransactionId: txId }
            });

            if (creditPurchase) {
                await prisma.conversationPurchase.update({
                    where: { id: creditPurchase.id },
                    data: {
                        status: isApproved ? "paid" : "pending",
                    }
                });

                // Si se aprueba y NO se ha aplicado aún, sumar créditos
                if (isApproved && !creditPurchase.isApplied) {
                    await prisma.empresa.update({
                        where: { id: creditPurchase.empresaId },
                        data: {
                            monthlyConversationLimit: {
                                increment: creditPurchase.creditsAmount
                            }
                        }
                    });

                    await prisma.conversationPurchase.update({
                        where: { id: creditPurchase.id },
                        data: { isApplied: true, appliedAt: new Date() }
                    });
                }
                return res.json({ ok: true, type: "credits_purchase" });
            }

            return res.json({ ok: true, ignored: "transaction_not_found_locally" });
        }

        return res.json({ ok: true, ignored: true });
    } catch (err: any) {
        console.error("❌ Error procesando webhook de Wompi:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
// // src/controllers/billing.controller.ts
// import { Request, Response } from "express";
// import prisma from "../lib/prisma";
// import * as Wompi from "../services/wompi.service";
// import { getEmpresaId } from "./_getEmpresaId";


// /* =======================================================
//    Config periodo de gracia + helpers de fecha
// ======================================================= */

// const GRACE_DAYS = 2;

// function addDays(date: Date, days: number): Date {
//     const d = new Date(date);
//     d.setDate(d.getDate() + days);
//     return d;
// }

// function addMonths(date: Date, months: number): Date {
//     const d = new Date(date);
//     d.setMonth(d.getMonth() + months);
//     return d;
// }

// /**
//  * Calcula el siguiente periodo de suscripción aplicando:
//  * - Si pagan ANTES de que termine el periodo + gracia → se ancla en currentPeriodEnd.
//  * - Si pagan DESPUÉS de la gracia → se ancla en hoy (now).
//  */
// function calculateRenewalPeriod(currentEnd: Date, now: Date) {
//     const graceLimit = addDays(currentEnd, GRACE_DAYS);
//     const baseStart = now <= graceLimit ? currentEnd : now;

//     const newStart = addDays(baseStart, 1);
//     const newEnd = addMonths(newStart, 1);

//     return { newStart, newEnd };
// }



// /* =======================================================
//    Helpers internos
// ======================================================= */

// // Obtiene un plan por código o lanza error
// async function getPlanOrThrow(code: "basic" | "pro") {
//     const plan = await prisma.subscriptionPlan.findUnique({
//         where: { code },
//     });

//     if (!plan) {
//         throw new Error(`No existe plan ${code}`);
//     }

//     return plan;
// }

// // Crea o reutiliza la suscripción para el plan indicado
// async function createOrUpdateSubscriptionForPlan(
//     empresaId: number,
//     planCode: "basic" | "pro"
// ) {
//     const plan = await getPlanOrThrow(planCode);

//     let subscription = await prisma.subscription.findFirst({
//         where: { empresaId },
//         orderBy: { createdAt: "desc" },
//         include: { plan: true },
//     });

//     if (subscription) {
//         if (subscription.planId !== plan.id) {
//             // upgrade / downgrade
//             subscription = await prisma.subscription.update({
//                 where: { id: subscription.id },
//                 data: {
//                     planId: plan.id,
//                     status: "active",
//                     cancelAtPeriodEnd: false,
//                     canceledAt: null,
//                 },
//                 include: { plan: true },
//             });
//         } else {
//             // mismo plan, asegurar active
//             subscription = await prisma.subscription.update({
//                 where: { id: subscription.id },
//                 data: {
//                     status: "active",
//                     cancelAtPeriodEnd: false,
//                 },
//                 include: { plan: true },
//             });
//         }
//     } else {
//         const now = new Date();
//         const nextMonth = new Date(now);
//         nextMonth.setMonth(now.getMonth() + 1);

//         subscription = await prisma.subscription.create({
//             data: {
//                 empresaId,
//                 planId: plan.id,
//                 currentPeriodStart: now,
//                 currentPeriodEnd: nextMonth,
//             },
//             include: { plan: true },
//         });
//     }

//     return { subscription, plan };
// }

// // Actualiza el plan de la empresa SOLO cuando hay pago aprobado
// async function syncEmpresaPlanWithSubscription(
//     empresaId: number,
//     planCode: "basic" | "pro"
// ) {
//     await prisma.empresa.update({
//         where: { id: empresaId },
//         data: {
//             plan: planCode,
//             estado: "activo",
//         },
//     });
// }

// /* =======================================================
//    1) Crear / cambiar método de pago (TOKEN ÚNICO)
//    - Crea token de tarjeta en Wompi (tok_...)
//    - Guarda el token y datos de la tarjeta en paymentMethod
// ======================================================= */

// export const createPaymentMethod = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const {
//             number,
//             cvc,
//             exp_month,
//             exp_year,
//             card_holder,
//             email,
//             deviceFingerprint, // sigue llegando desde el front
//         } = req.body;

//         // Mantengo la validación para no romper el frontend actual
//         if (!deviceFingerprint) {
//             return res.status(400).json({
//                 ok: false,
//                 error: "DEVICE_FINGERPRINT_REQUIRED",
//             });
//         }

//         if (!number || !cvc || !exp_month || !exp_year || !card_holder) {
//             return res.status(400).json({
//                 ok: false,
//                 error: "CARD_DATA_INCOMPLETE",
//             });
//         }

//         // 1. Crear token de tarjeta en Wompi (tok_...)
//         const cardToken = await Wompi.createPaymentSource({
//             number,
//             cvc,
//             exp_month,
//             exp_year,
//             card_holder,
//         });

//         // 2. Marcar métodos anteriores como no default
//         await prisma.paymentMethod.updateMany({
//             where: { empresaId },
//             data: { isDefault: false },
//         });

//         // 3. Datos auxiliares
//         const lastFour =
//             cardToken?.last_four ??
//             (typeof number === "string" && number.length >= 4
//                 ? number.slice(-4)
//                 : null);

//         const brand = cardToken?.brand ?? null;

//         // 4. Guardar método de pago con el token de Wompi
//         const payment = await prisma.paymentMethod.create({
//             data: {
//                 empresaId,
//                 wompiSourceId: null,               // ya no usamos payment_source
//                 wompiToken: cardToken?.id || null, // ← token para cobros
//                 brand,
//                 lastFour,
//                 expMonth: exp_month,
//                 expYear: exp_year,
//                 isDefault: true,
//                 cardHolder: card_holder,
//                 email: email || null,
//                 status: "AVAILABLE",               // estado local
//             },
//         });

//         return res.json({
//             ok: true,
//             paymentMethod: payment,
//             // Para no romper el frontend que esperaba wompiSource
//             wompiSource: {
//                 id: null,
//                 status: "AVAILABLE",
//                 redirect_url: null,
//             },
//         });
//     } catch (error: any) {
//         console.error("🔥 ERROR en createPaymentMethod() ------------------");
//         console.error("Mensaje:", error.message);

//         if (error.response) {
//             console.error("Status Wompi:", error.response.status);
//             console.error("Data Wompi:", error.response.data);
//         } else {
//             console.error("Error sin response:", error);
//         }

//         return res.status(500).json({
//             ok: false,
//             error: "WOMPI_ERROR",
//             details: error.response?.data || error.message,
//         });
//     }
// };

// /* =======================================================
//    2) Eliminar método de pago por defecto
// ======================================================= */

// export const deletePaymentMethod = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const pm = await prisma.paymentMethod.findFirst({
//             where: { empresaId, isDefault: true },
//         });

//         if (!pm) {
//             return res
//                 .status(404)
//                 .json({ ok: false, error: "No hay método de pago para eliminar" });
//         }

//         // Romper referencia en pagos históricos
//         await prisma.subscriptionPayment.updateMany({
//             where: { paymentMethodId: pm.id },
//             data: { paymentMethodId: null },
//         });

//         await prisma.paymentMethod.delete({
//             where: { id: pm.id },
//         });

//         return res.json({ ok: true });
//     } catch (error: any) {
//         console.error("Error eliminando método de pago:", error);
//         return res.status(500).json({
//             ok: false,
//             error: error.message || "Error eliminando método de pago",
//         });
//     }
// };

// /* =======================================================
//    3) Crear / actualizar suscripción BASIC
// ======================================================= */

// export const createSubscriptionBasic = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const { subscription, plan } = await createOrUpdateSubscriptionForPlan(
//             empresaId,
//             "basic"
//         );

//         return res.json({
//             ok: true,
//             subscription,
//             plan,
//         });
//     } catch (error: any) {
//         console.error("Error creando suscripción BASIC:", error);
//         return res.status(500).json({
//             ok: false,
//             error: error.message || "Error creando suscripción BASIC",
//         });
//     }
// };

// /* =======================================================
//    3.b) Crear / actualizar suscripción PRO
// ======================================================= */

// export const createSubscriptionPro = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const { subscription, plan } = await createOrUpdateSubscriptionForPlan(
//             empresaId,
//             "pro"
//         );

//         return res.json({
//             ok: true,
//             subscription,
//             plan,
//         });
//     } catch (error: any) {
//         console.error("Error creando suscripción PRO:", error);
//         return res.status(500).json({
//             ok: false,
//             error: error.message || "Error creando suscripción PRO",
//         });
//     }
// };

// /* =======================================================
//    4) Cobrar suscripción (CARD + token, PENDING manejado)
// ======================================================= */

// export const chargeSubscription = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const empresa = await prisma.empresa.findUnique({
//             where: { id: empresaId },
//             include: {
//                 paymentMethods: { where: { isDefault: true }, take: 1 },
//                 subscriptions: {
//                     where: { status: "active" },
//                     take: 1,
//                     orderBy: { createdAt: "desc" },
//                     include: { plan: true },
//                 },
//             },
//         });

//         if (
//             !empresa ||
//             !empresa.subscriptions.length ||
//             !empresa.paymentMethods.length
//         ) {
//             return res
//                 .status(400)
//                 .json({ ok: false, error: "Sin suscripción o método de pago" });
//         }

//         const subscription = empresa.subscriptions[0];
//         const pm = empresa.paymentMethods[0];

//         if (!pm.wompiToken) {
//             return res.status(400).json({
//                 ok: false,
//                 error: "Método de pago sin token de Wompi (wompiToken)",
//             });
//         }

//         // 🔹 Buscar email en la tabla usuario (primer usuario de esa empresa)
//         const usuarioBilling = await prisma.usuario.findFirst({
//             where: { empresaId },
//         });

//         const customerEmail =
//             pm.email || usuarioBilling?.email || "cliente@example.com";

//         // Monto en centavos (price viene en unidades monetarias)
//         const amountInCents = Math.round(Number(subscription.plan.price) * 100);
//         const reference = `sub_${subscription.id}_${Date.now()}`;

//         console.log(
//             "💳 [BILLING] Cobro de suscripción usando token de tarjeta:",
//             pm.wompiToken
//         );

//         // 💳 Cobro usando el token
//         const wompiResp = await Wompi.chargeWithToken({
//             token: pm.wompiToken,
//             amountInCents,
//             customerEmail,
//             reference,
//         });

//         // `chargeWithToken` devuelve `response.data`, pero por seguridad
//         const wompiData = wompiResp?.data ?? wompiResp;
//         const txStatus = wompiData.status as string;

//         const isApproved = txStatus === "APPROVED";
//         const isPending = txStatus === "PENDING";

//         const paymentRecord = await prisma.subscriptionPayment.create({
//             data: {
//                 empresaId,
//                 subscriptionId: subscription.id,
//                 paymentMethodId: pm.id,
//                 amount: subscription.plan.price,
//                 wompiTransactionId: wompiData.id,
//                 status: isApproved ? "paid" : "pending",
//                 paidAt: isApproved ? new Date() : null,
//                 errorMessage: isApproved ? null : JSON.stringify(wompiData),
//             },
//         });

//         if (isApproved) {
//             const now = new Date();
//             const currentEnd = subscription.currentPeriodEnd;

//             const { newStart, newEnd } = calculateRenewalPeriod(currentEnd, now);

//             await prisma.subscription.update({
//                 where: { id: subscription.id },
//                 data: {
//                     currentPeriodStart: newStart,
//                     currentPeriodEnd: newEnd,
//                     status: "active",
//                 },
//             });

//             const newPlanCode = subscription.plan.code as "basic" | "pro";
//             await syncEmpresaPlanWithSubscription(empresaId, newPlanCode);
//         }


//         // 👇 Respuesta al frontend distinguiendo estados
//         if (isApproved) {
//             return res.json({
//                 ok: true,
//                 message: "Pago aprobado",
//                 payment: paymentRecord,
//                 wompi: wompiData,
//             });
//         }

//         if (isPending) {
//             return res.json({
//                 ok: true,
//                 message: "Pago en proceso de aprobación",
//                 payment: paymentRecord,
//                 wompi: wompiData,
//             });
//         }

//         // Otros estados (DECLINED, ERROR, VOIDED, etc.)
//         return res.json({
//             ok: false,
//             message: "Pago no aprobado",
//             payment: paymentRecord,
//             wompi: wompiData,
//         });
//     } catch (error: any) {
//         console.error(
//             "Error cobrando suscripción:",
//             error?.response?.data || error.message || error
//         );
//         return res
//             .status(500)
//             .json({ ok: false, error: "Error cobrando suscripción" });
//     }
// };

// /* =======================================================
//    5) Dashboard de Billing (estado general)
// ======================================================= */

// export const getBillingStatus = async (req: Request, res: Response) => {
//     try {
//         const empresaId = getEmpresaId(req);

//         const empresa = await prisma.empresa.findUnique({
//             where: { id: empresaId },
//             include: {
//                 paymentMethods: { where: { isDefault: true }, take: 1 },
//                 subscriptions: {
//                     where: { status: "active" },
//                     take: 1,
//                     orderBy: { createdAt: "desc" },
//                     include: { plan: true },
//                 },
//                 subscriptionPayments: {
//                     orderBy: { createdAt: "desc" },
//                     take: 10,
//                 },
//             },
//         });

//         const subscription = empresa?.subscriptions[0] || null;

//         // Meta de estado de suscripción: días restantes y periodo de gracia
//         let daysLeft: number | null = null;
//         let isInGrace = false;
//         let isActiveForUse = false;

//         if (subscription) {
//             const now = new Date();
//             const end = subscription.currentPeriodEnd;
//             const diffMs = end.getTime() - now.getTime();

//             daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

//             const graceLimit = addDays(end, GRACE_DAYS);

//             isInGrace = daysLeft < 0 && now <= graceLimit;
//             // Se considera activa para uso mientras no pase el límite de gracia
//             isActiveForUse = now <= graceLimit;
//         }


//         return res.json({
//             ok: true,
//             paymentMethod: empresa?.paymentMethods[0] || null,
//             subscription,
//             payments: empresa?.subscriptionPayments || [],
//             empresaPlan: empresa?.plan || "gratis",
//             empresaEstado: empresa?.estado || null,
//             nextBillingDate: subscription?.currentPeriodEnd || null,
//             meta: {
//                 daysLeft,
//                 isInGrace,
//                 isActiveForUse,
//                 graceDays: GRACE_DAYS,
//             },
//         });

//     } catch (err: any) {
//         console.error("Error cargando estado de billing:", err);
//         return res.status(500).json({ ok: false, error: err.message });
//     }
// };

// /* =======================================================
//    6) Webhook de Wompi (payment_source.updated, transaction.updated)
// ======================================================= */

// export const handleWompiWebhook = async (req: Request, res: Response) => {
//     try {
//         const body = req.body as any;
//         const event = body?.event;
//         const data = body?.data;

//         console.log("📩 [WOMPI WEBHOOK] Evento recibido:", event);

//         if (!event || !data) {
//             return res.status(400).json({ ok: false, error: "Payload inválido" });
//         }

//         /* 1) payment_source.updated → actualizar método de pago */
//         if (event === "payment_source.updated") {
//             const sourceId = data.id;
//             const status = data.status;

//             console.log("🔄 payment_source.updated:", { sourceId, status });

//             await prisma.paymentMethod.updateMany({
//                 where: { wompiSourceId: String(sourceId) },
//                 data: {
//                     status,
//                     // opcional: marcar default al quedar AVAILABLE
//                     isDefault: status === "AVAILABLE" ? true : undefined,
//                 },
//             });

//             return res.json({ ok: true });
//         }

//         /* 2) transaction.updated → actualizar pago y plan */
//         if (event === "transaction.updated") {
//             console.log(
//                 "🔄 transaction.updated RAW:",
//                 JSON.stringify(data, null, 2)
//             );

//             const txId =
//                 data?.id ||
//                 data?.transaction?.id ||
//                 data?.payload?.transaction?.id;

//             const txStatus =
//                 data?.status ||
//                 data?.transaction?.status ||
//                 data?.payload?.transaction?.status;

//             console.log("🔄 transaction.updated:", { txId, txStatus });

//             if (!txId || !txStatus) {
//                 console.error(
//                     "⚠️ Webhook recibido sin campos id/status válidos:",
//                     data
//                 );
//                 return res.json({ ok: false, ignored: "invalid_payload" });
//             }

//             const payment = await prisma.subscriptionPayment.findFirst({
//                 where: { wompiTransactionId: txId },
//                 include: { subscription: { include: { plan: true } } },
//             });

//             if (!payment) {
//                 console.warn("⚠️ No se encontró subscriptionPayment para tx:", txId);
//                 return res.json({ ok: true, ignored: "no_payment" });
//             }

//             const isApproved = txStatus === "APPROVED";

//             // Actualizar registro de pago
//             await prisma.subscriptionPayment.update({
//                 where: { id: payment.id },
//                 data: {
//                     status: isApproved ? "paid" : "pending",
//                     paidAt: isApproved ? new Date() : null,
//                     errorMessage: isApproved ? null : JSON.stringify(data),
//                 },
//             });

//             // Si se aprobó, actualizar suscripción + plan de empresa (con periodo de gracia)
//             if (isApproved && payment.subscriptionId && payment.subscription?.plan) {
//                 const now = new Date();

//                 // Traer la suscripción actual para leer bien el currentPeriodEnd
//                 const subscription = await prisma.subscription.findUnique({
//                     where: { id: payment.subscriptionId },
//                 });

//                 if (subscription) {
//                     const { newStart, newEnd } = calculateRenewalPeriod(
//                         subscription.currentPeriodEnd,
//                         now
//                     );

//                     await prisma.subscription.update({
//                         where: { id: payment.subscriptionId },
//                         data: {
//                             currentPeriodStart: newStart,
//                             currentPeriodEnd: newEnd,
//                             status: "active",
//                         },
//                     });

//                     await syncEmpresaPlanWithSubscription(
//                         payment.empresaId,
//                         payment.subscription.plan.code as "basic" | "pro"
//                     );
//                 }
//             }


//             return res.json({ ok: true });
//         }

//         // Otros eventos de Wompi que por ahora no manejas
//         console.log("ℹ️ Evento Wompi no manejado:", event);
//         return res.json({ ok: true, ignored: true });
//     } catch (err: any) {
//         console.error("❌ Error procesando webhook de Wompi:", err);
//         return res.status(500).json({ ok: false, error: err.message });
//     }
// };

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
    300: 50000,  // 300 conversaciones por $50.000
    600: 90000,  // 600 conversaciones por $90.000 (Descuento)
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

        const {
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
            email,
            deviceFingerprint, // sigue llegando desde el front
        } = req.body;

        if (!deviceFingerprint) {
            return res.status(400).json({
                ok: false,
                error: "DEVICE_FINGERPRINT_REQUIRED",
            });
        }

        if (!number || !cvc || !exp_month || !exp_year || !card_holder) {
            return res.status(400).json({
                ok: false,
                error: "CARD_DATA_INCOMPLETE",
            });
        }

        // 1. Crear token de tarjeta en Wompi (tok_...)
        const cardToken = await Wompi.createPaymentSource({
            number,
            cvc,
            exp_month,
            exp_year,
            card_holder,
        });

        // 2. Marcar métodos anteriores como no default
        await prisma.paymentMethod.updateMany({
            where: { empresaId },
            data: { isDefault: false },
        });

        // 3. Datos auxiliares
        const lastFour =
            cardToken?.last_four ??
            (typeof number === "string" && number.length >= 4
                ? number.slice(-4)
                : null);

        const brand = cardToken?.brand ?? null;

        // 4. Guardar método de pago con el token de Wompi
        const payment = await prisma.paymentMethod.create({
            data: {
                empresaId,
                wompiSourceId: null,               // ya no usamos payment_source
                wompiToken: cardToken?.id || null, // ← token para cobros
                brand,
                lastFour,
                expMonth: exp_month,
                expYear: exp_year,
                isDefault: true,
                cardHolder: card_holder,
                email: email || null,
                status: "AVAILABLE",               // estado local
            },
        });

        return res.json({
            ok: true,
            paymentMethod: payment,
            wompiSource: {
                id: null,
                status: "AVAILABLE",
                redirect_url: null,
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

        if (!pm.wompiToken) {
            return res.status(400).json({
                ok: false,
                error: "Método de pago sin token de Wompi (wompiToken)",
            });
        }

        const usuarioBilling = await prisma.usuario.findFirst({
            where: { empresaId },
        });

        const customerEmail =
            pm.email || usuarioBilling?.email || "cliente@example.com";

        // Monto en centavos
        const amountInCents = Math.round(Number(subscription.plan.price) * 100);
        const reference = `sub_${subscription.id}_${Date.now()}`;

        console.log("💳 [BILLING] Cobrando suscripción...", { reference, amountInCents });

        // 💳 Cobro usando el token
        const wompiResp = await Wompi.chargeWithToken({
            token: pm.wompiToken,
            amountInCents,
            customerEmail,
            reference,
        });

        const wompiData = wompiResp?.data ?? wompiResp;
        const txStatus = wompiData.status as string;

        const isApproved = txStatus === "APPROVED";
        const isPending = txStatus === "PENDING";

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
            // ✨ ACTUALIZADO: Usamos gracePeriodDays directamente desde la BD
            const { newStart, newEnd } = calculateRenewalPeriod(
                subscription.currentPeriodEnd,
                now,
                subscription.plan.gracePeriodDays // <--- Dinámico
            );

            await prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                    currentPeriodStart: newStart,
                    currentPeriodEnd: newEnd,
                    status: "active",
                },
            });

            // ✨ ACTUALIZADO: Reseteamos contadores (used=0) y actualizamos límites
            await syncEmpresaPlanAndLimits(empresaId, subscription.plan);
        }

        if (isApproved) {
            return res.json({
                ok: true,
                message: "Pago aprobado",
                payment: paymentRecord,
                wompi: wompiData,
            });
        }

        if (isPending) {
            return res.json({
                ok: true,
                message: "Pago en proceso de aprobación",
                payment: paymentRecord,
                wompi: wompiData,
            });
        }

        return res.json({
            ok: false,
            message: "Pago no aprobado",
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
   ✨ 5) COMPRA DE CRÉDITOS EXTRA (Top-ups)
   Nueva funcionalidad para comprar 300 o 600 conversaciones
======================================================= */

export const purchaseConversationCredits = async (req: Request, res: Response) => {
    try {
        const empresaId = getEmpresaId(req);
        const { amount } = req.body; // Espera: 300 o 600

        // 1. Validar precio del paquete
        const priceCOP = CREDIT_PACKAGES[Number(amount)];
        if (!priceCOP) {
            return res.status(400).json({
                ok: false,
                error: "Paquete inválido. Solo disponible: 300 o 600."
            });
        }

        // 2. Buscar método de pago
        const empresa = await prisma.empresa.findUnique({
            where: { id: empresaId },
            include: {
                paymentMethods: { where: { isDefault: true }, take: 1 }
            }
        });
        const pm = empresa?.paymentMethods[0];

        if (!pm || !pm.wompiToken) {
            return res.status(400).json({ ok: false, error: "No tienes método de pago registrado." });
        }

        // 3. Preparar cobro
        const amountInCents = priceCOP * 100;
        const reference = `topup_${empresaId}_${Date.now()}`;

        const usuarioBilling = await prisma.usuario.findFirst({ where: { empresaId } });
        const customerEmail = pm.email || usuarioBilling?.email || "cliente@example.com";

        // 4. Cobrar en Wompi
        const wompiResp = await Wompi.chargeWithToken({
            token: pm.wompiToken,
            amountInCents,
            customerEmail,
            reference,
        });

        const wompiData = wompiResp?.data ?? wompiResp;
        const txStatus = wompiData.status as string;
        const isApproved = txStatus === "APPROVED";

        // 5. Registrar intento de compra
        const purchase = await prisma.conversationPurchase.create({
            data: {
                empresaId,
                creditsAmount: Number(amount),
                pricePaid: priceCOP,
                wompiTransactionId: wompiData.id,
                status: isApproved ? "paid" : "pending",
                isApplied: isApproved, // Si aprobado, se aplica ya
                appliedAt: isApproved ? new Date() : null,
                errorMessage: isApproved ? null : JSON.stringify(wompiData),
            }
        });

        // 6. Si aprobado, incrementar límite inmediatamente
        if (isApproved) {
            await prisma.empresa.update({
                where: { id: empresaId },
                data: {
                    monthlyConversationLimit: {
                        increment: Number(amount) // SUMA al límite actual
                    }
                }
            });
        }

        return res.json({
            ok: isApproved || txStatus === "PENDING",
            message: isApproved ? "Créditos agregados exitosamente." : "Pago en proceso.",
            purchase,
            wompi: wompiData
        });

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
                // ✨ NUEVO: Historial de compra de paquetes
                conversationPurchases: {
                    orderBy: { createdAt: "desc" },
                    take: 5
                }
            },
        });

        const subscription = empresa?.subscriptions[0] || null;

        let daysLeft: number | null = null;
        let isInGrace = false;
        let isActiveForUse = false;
        // Obtenemos los días de gracia del plan o un default de seguridad
        const graceDaysPlan = subscription?.plan?.gracePeriodDays ?? 2;

        if (subscription) {
            const now = new Date();
            const end = subscription.currentPeriodEnd;
            const diffMs = end.getTime() - now.getTime();

            daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

            // ✨ ACTUALIZADO: Usamos variable dinámica
            const graceLimit = addDays(end, graceDaysPlan);

            isInGrace = daysLeft < 0 && now <= graceLimit;
            isActiveForUse = now <= graceLimit;
        }

        return res.json({
            ok: true,
            paymentMethod: empresa?.paymentMethods[0] || null,
            subscription,
            payments: empresa?.subscriptionPayments || [],
            conversationPurchases: empresa?.conversationPurchases || [], // Enviamos al front

            empresaPlan: empresa?.plan || "gratis",
            empresaEstado: empresa?.estado || null,

            // ✨ NUEVO: Info de consumo para el dashboard
            usage: {
                used: empresa?.conversationsUsed || 0,
                limit: empresa?.monthlyConversationLimit || 0,
            },

            nextBillingDate: subscription?.currentPeriodEnd || null,
            meta: {
                daysLeft,
                isInGrace,
                isActiveForUse,
                graceDays: graceDaysPlan, // Para mostrar en UI
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
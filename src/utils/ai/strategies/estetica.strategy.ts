// utils/ai/strategies/estetica.strategy.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Estrategia Estética — "Híbrido inteligente"
 * - Lee KB + Horarios, genera un "resumen caliente" y lo guarda en ConversationState (TTL corto).
 * - Usa historial compacto + ese resumen para responder de forma libre y natural con emojis.
 * - Si detecta intención de agenda -> propone horarios y pide datos; doble confirmación antes de crear.
 * - Tipado de mensajes del LLM corregido (role: "user" | "assistant" | "system").
 */

import prisma from "../../../lib/prisma";
import { openai } from "../../../lib/openai";

import type {
    AppointmentVertical,
    ConversationEstado,
    MessageFrom,
} from "@prisma/client";

import {
    loadEsteticaKB,
    resolveServiceName,
    serviceDisplayPrice,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

import {
    getNextAvailableSlots,
    createAppointmentSafe,
    type Slot,
} from "./esteticaModules/schedule/estetica.schedule";

import { addMinutes } from "date-fns";
import { utcToZonedTime, format as tzFormat } from "date-fns-tz";

/* ===================== Config (sin ENV) ===================== */
const STATE_TTL_MS = 5 * 60_000;           // 5 min cache de resumen
const HISTORY_TAKE = 8;                    // historial breve
const MAX_SLOTS_TO_SHOW = 6;               // cuantos horarios proponer
const GRANULARITY_MIN = 15;                // paso en minutos para slots
const DEFAULT_DUR_MIN = 60;                // duración por defecto
const MAX_OUT_TOKENS = 220;                // salida LLM
const MODEL_NAME = "gpt-4o-mini";          // usa tu modelo por defecto
const BASE_TEMP = 0.5;

/* ===================== Tipos LLM ===================== */
type Role = "system" | "user" | "assistant";
type ChatMsg = { role: Role; content: string };

/* ===================== Utilidades ===================== */
const EMOJIS = {
    greet: ["👋", "✨", "😊", "🙌"],
    ask: ["🤔", "📝", "💬"],
    calendar: ["📅", "🗓️"],
    ok: ["✅", "👌", "🟢"],
    info: ["ℹ️", "💡"],
};
function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}
function humanizeList(items: string[], sep = " • "): string {
    return items.filter(Boolean).join(sep);
}
function formatCOP(v?: number | null): string | null {
    if (v == null || isNaN(Number(v))) return null;
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(Number(v));
}
async function getHistory(conversationId: number): Promise<ChatMsg[]> {
    const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: "desc" },
        take: HISTORY_TAKE,
        select: { from: true, contenido: true },
    });
    return rows
        .reverse()
        .map((m) => ({
            role: (m.from === "client" ? "user" : "assistant") as Role,
            content: (m.contenido || "").trim(),
        }))
        .filter((x) => !!x.content);
}

/* ===================== ConversationState ===================== */
type HotState = {
    kbSummary?: string;         // resumen textual KB
    scheduleSummary?: string;   // resumen textual de horarios/reglas
    lastProcedureName?: string; // contexto "de qué servicio hablaban"
    lastUpdatedAt?: number;
};
async function readState(conversationId: number): Promise<HotState | null> {
    const row = await prisma.conversationState.findUnique({
        where: { conversationId },
        select: { data: true, updatedAt: true },
    });
    if (!row) return null;
    const updatedAt = row.updatedAt?.getTime() || 0;
    if (Date.now() - updatedAt > STATE_TTL_MS) return null; // expirado
    try {
        return (row.data as HotState) || null;
    } catch {
        return null;
    }
}
async function writeState(conversationId: number, data: HotState) {
    await prisma.conversationState.upsert({
        where: { conversationId },
        update: { data, updatedAt: new Date() },
        create: {
            conversationId,
            data,
        },
    });
}

/* ===================== Resumen KB + Schedule ===================== */
function summarizeKB(kb: EsteticaKB): string {
    const servicios = kb.procedures
        .filter((p) => p.enabled)
        .map((p) => {
            const desde = p.priceMin != null ? formatCOP(Number(p.priceMin)) : null;
            return desde ? `${p.name} (Desde ${desde})` : p.name;
        });

    const parts = [
        kb.businessName ? `Clínica: ${kb.businessName}.` : "",
        `Zona horaria: ${kb.timezone}. Buffer min: ${kb.bufferMin}m.`,
        kb.policies ? `Políticas: ${kb.policies}` : "",
        servicios.length ? `Servicios habilitados: ${servicios.join(" • ")}.` : "",
        kb.location?.address ? `Dirección: ${kb.location.address}.` : "",
    ].filter(Boolean);

    return parts.join("\n");
}

function summarizeSchedule(kb: EsteticaKB): string {
    // Aquí solo agregamos reglas generales que ya vienen por KB/config.
    const rules: string[] = [];
    if (kb.allowSameDay) rules.push("Se permite reservar en el mismo día.");
    if (kb.minNoticeHours)
        rules.push(`Anticipación mínima: ${kb.minNoticeHours}h.`);
    if (kb.maxAdvanceDays)
        rules.push(`Anticipación máxima: ${kb.maxAdvanceDays} días.`);
    if (kb.defaultServiceDurationMin)
        rules.push(`Duración por defecto: ${kb.defaultServiceDurationMin} min.`);

    return rules.length ? rules.join(" ") : "Reglas operativas: estándar.";
}

/* ===================== Intención ===================== */
function intentOf(text: string): "price" | "schedule" | "faq" | "other" {
    const t = (text || "").toLowerCase();
    if (/\b(precio|costo|valor|cuánto vale|cuanto vale|tarifa|cuánto cuesta|cuanto cuesta)\b/.test(t)) return "price";
    if (/\b(horario|horarios|agenda|agendar|cita|disponibilidad|domingos|días|dias)\b/.test(t)) return "schedule";
    if (/\b(beneficio|beneficios|indicacion|indicaciones|antes|después|despues|contraindica|contraindicaciones|qué es|que es|en qué consiste|en que consiste)\b/.test(t)) return "faq";
    return "other";
}

/* ===================== LLM runner ===================== */
async function runLLM(messages: ChatMsg[]): Promise<string> {
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: MODEL_NAME,
            temperature: BASE_TEMP,
            max_tokens: MAX_OUT_TOKENS,
            messages,
        });
        return resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e: any) {
        return "Gracias por escribirme. Te oriento y, si quieres, te comparto horarios. 🙂";
    }
}

/* ===================== Persistencia reply ===================== */
async function persistReply(
    conversationId: number,
    empresaId: number,
    texto: string,
    nuevo: ConversationEstado
) {
    const msg = await prisma.message.create({
        data: {
            conversationId,
            empresaId,
            from: "bot" as MessageFrom,
            contenido: texto,
        },
    });
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevo },
    });
    return { messageId: msg.id, estado: nuevo, texto };
}

/* ===================== Helpers de agenda ===================== */
function labelsFromSlots(slots: Slot[], tz: string, take = MAX_SLOTS_TO_SHOW): string[] {
    const picked = slots.slice(0, take);
    const out: string[] = [];
    for (const s of picked) {
        const start = new Date(s.startISO);
        const local = utcToZonedTime(start, tz);
        const label =
            tzFormat(local, "EEE dd/MM", { timeZone: tz }) +
            " " +
            tzFormat(local, "HH:mm", { timeZone: tz });
        out.push(label);
    }
    return out;
}

/* ===================== API pública ===================== */
export async function esteticaAgentReply(args: {
    conversationId: number;
    empresaId: number;
    userText: string;
}): Promise<{ estado: ConversationEstado; mensaje: string }> {
    const { conversationId, empresaId, userText } = args;

    // 1) KB
    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) {
        const fallback = "Por ahora no tengo la configuración completa de la clínica. Te comunico con un asesor. 🙏";
        await persistReply(conversationId, empresaId, fallback, "requiere_agente");
        return { estado: "requiere_agente", mensaje: fallback };
    }

    // 2) State (hot summary) — refrescar si expiró
    let state = await readState(conversationId);
    if (!state) {
        state = {
            kbSummary: summarizeKB(kb),
            scheduleSummary: summarizeSchedule(kb),
            lastUpdatedAt: Date.now(),
        };
        await writeState(conversationId, state);
    }

    // 3) Contexto de servicio (si lo mencionan)
    const { procedure } = resolveServiceName(kb, userText || "");
    if (procedure) {
        state.lastProcedureName = procedure.name;
        await writeState(conversationId, state);
    }

    // 4) Intención y flujo suave
    const it = intentOf(userText || "");
    if (it === "schedule") {
        // ofrecer horarios cercanos
        const duration =
            procedure?.durationMin ??
            kb.defaultServiceDurationMin ??
            DEFAULT_DUR_MIN;

        // fecha ancla = HOY (zona negocio)
        const nowLocalISO = tzFormat(utcToZonedTime(new Date(), kb.timezone), "yyyy-MM-dd", { timeZone: kb.timezone });
        const groups = await getNextAvailableSlots(
            {
                empresaId,
                timezone: kb.timezone,
                vertical: kb.vertical,
                bufferMin: kb.bufferMin,
                granularityMin: GRANULARITY_MIN,
            },
            nowLocalISO,
            duration,
            14,
            MAX_SLOTS_TO_SHOW
        );

        if (!groups.length) {
            const txt = `No veo cupos cercanos ${pick(EMOJIS.ask)}. ¿Te parece si te contacto con un asesor para coordinar mejor?`;
            const r = await persistReply(conversationId, empresaId, txt, "en_proceso");
            return { estado: r.estado, mensaje: r.texto };
        }

        const flat: Slot[] = groups.flatMap((g) => g.slots);
        const labels = labelsFromSlots(flat, kb.timezone, MAX_SLOTS_TO_SHOW);
        const svc = procedure?.name ?? state.lastProcedureName ?? "el procedimiento";

        const txt =
            `Tengo disponibilidad cercana ${pick(EMOJIS.calendar)}:\n` +
            `• ${labels.join("  • ")}\n\n` +
            `Elige una y dime tu *nombre* y *teléfono* para reservar ${pick(EMOJIS.ok)}.\n` +
            `(Servicio: ${svc})`;

        const r = await persistReply(conversationId, empresaId, txt, "en_proceso");
        return { estado: r.estado, mensaje: r.texto };
    }

    if (it === "price") {
        // responder precio natural, aprovechando último contexto si no repiten servicio
        const svc =
            procedure ??
            (state.lastProcedureName
                ? kb.procedures.find((p) => p.name === state!.lastProcedureName)
                : null);

        if (svc) {
            const desde = svc.priceMin != null ? formatCOP(Number(svc.priceMin)) : null;
            const dur = svc.durationMin ?? kb.defaultServiceDurationMin ?? DEFAULT_DUR_MIN;
            const cola = `¿Quieres que te comparta horarios? ${pick(EMOJIS.calendar)}`;
            const cuerpo = [
                `Para *${svc.name}*:`,
                desde ? `• Valor: *Desde ${desde}*.` : "• Valor: consultar en sede.",
                `• Duración aprox.: ${dur} min.`,
                svc.depositRequired && svc.depositAmount != null
                    ? `• Anticipo: ${formatCOP(Number(svc.depositAmount))}.`
                    : "",
                cola,
            ]
                .filter(Boolean)
                .join("\n");

            const r = await persistReply(conversationId, empresaId, cuerpo, "en_proceso");
            return { estado: r.estado, mensaje: r.texto };
        }
        // sin servicio claro -> listar
        const servicios = kb.procedures
            .filter((p) => p.enabled)
            .map((p) => {
                const d = p.priceMin != null ? formatCOP(Number(p.priceMin)) : null;
                return d ? `${p.name} (Desde ${d})` : p.name;
            });
        const txt =
            `Manejo estos procedimientos ${pick(EMOJIS.info)}:\n` +
            `• ${servicios.join("  • ")}\n\n` +
            `Dime cuál te interesa y te digo el valor desde y horarios ${pick(EMOJIS.calendar)}.`;
        const r = await persistReply(conversationId, empresaId, txt, "en_proceso");
        return { estado: r.estado, mensaje: r.texto };
    }

    // 5) Respuesta libre orientada (FAQ/other) con KB+Schedule en system + historial
    const system = [
        `Eres asesora de clínica estética${kb.businessName ? ` "${kb.businessName}"` : ""}.`,
        `Estilo: humano, cálido y profesional. Usa emojis sutiles (${pick(EMOJIS.greet)}).`,
        `Responde en 2–6 líneas, sin plantillas repetitivas. Evita sonar como bot.`,
        `Si el usuario pide agendar o pregunta por horarios, ofrece opciones concretas.`,
        `Precios: usa "Desde $X (COP)" si hay priceMin; si no hay, sugiere consultar.`,
        `Contexto negocio:\n${state.kbSummary || summarizeKB(kb)}`,
        `Operación/agenda:\n${state.scheduleSummary || summarizeSchedule(kb)}`,
        state.lastProcedureName ? `Último servicio en contexto: ${state.lastProcedureName}.` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const history = await getHistory(conversationId);
    const messages: ChatMsg[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: (userText || "").trim() || "Hola" },
    ];

    const texto = await runLLM(messages);
    const r = await persistReply(conversationId, empresaId, texto, "respondido");
    return { estado: r.estado, mensaje: r.texto };
}

/* ===================== Crear cita confirmada (opcional) ===================== */
export async function bookConfirmedSlot(args: {
    empresaId: number;
    conversationId: number;
    procedureName: string;
    customerName: string;
    customerPhone: string;
    startISO: string;
    endISO: string;
}) {
    const { empresaId, conversationId, procedureName, customerName, customerPhone, startISO, endISO } = args;

    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) throw new Error("Config no disponible.");

    const proc =
        kb.procedures.find((p) => p.name.toLowerCase() === procedureName.toLowerCase()) || null;

    const appt = await createAppointmentSafe({
        empresaId,
        vertical: kb.vertical,
        timezone: kb.timezone,
        procedureId: proc?.id ?? null,
        serviceName: procedureName,
        customerName,
        customerPhone,
        startISO,
        endISO,
        source: "ai",
        notes: null,
    });

    const local = utcToZonedTime(appt.startAt, kb.timezone);
    const fecha =
        tzFormat(local, "EEEE dd 'de' MMMM", { timeZone: kb.timezone }) +
        " a las " +
        tzFormat(local, "HH:mm", { timeZone: kb.timezone });

    const txt = `¡Listo! ${pick(EMOJIS.ok)} Tu cita de *${procedureName}* quedó para **${fecha}**.`;
    await persistReply(conversationId, empresaId, txt, "respondido");
    return appt;
}

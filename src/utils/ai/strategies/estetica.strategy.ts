// utils/ai/strategies/estetica.strategy.ts
/**
 * Agente Estética – Híbrido inteligente (con envío directo a WhatsApp)
 * - Memoria corta en conversation_state (TTL 5 min) + flag hasGreeted
 * - Resumen embebido para bajar tokens
 * - Tono humano + emojis + variedad
 * - Sale/entra del flujo de agenda de forma suave (intención)
 * - Lee catálogo real (estetica.kb) + agenda real (estetica.schedule)
 * - Envía por WhatsApp Cloud API y persiste con externalId (wamid)
 */

import prisma from "../../../lib/prisma";
import type { Prisma } from "@prisma/client";
import { openai } from "../../../lib/openai";

import {
    loadEsteticaKB,
    resolveServiceName,
    serviceDisplayPrice,
    MONEY_RE as KB_MONEY_RE,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

import {
    getNextAvailableSlots,
    createAppointmentSafe,
} from "./esteticaModules/schedule/estetica.schedule";

import { addMinutes } from "date-fns";
import { utcToZonedTime, format as tzFormat } from "date-fns-tz";

/* ======== Defaults (sin ENV) ======== */
const CONF = {
    MEM_TTL_MIN: 5,
    GRAN_MIN: 15,
    MAX_SLOTS: 6,
    DAYS_HORIZON: 14,
    MAX_HISTORY: 10,
    REPLY_MAX_LINES: 5,
    TEMPERATURE: 0.6,
    MODEL: "gpt-4o-mini",
};

/* ======== Helpers ======== */
function softTrim(s: string | null | undefined, max = 240) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function endsWithPunctuation(t: string) {
    return /[.!?…]\s*$/.test((t || "").trim());
}
function closeNicely(raw: string): string {
    let t = (raw || "").trim();
    if (!t) return t;
    if (endsWithPunctuation(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    return t ? `${t}…` : raw.trim();
}
function clampLines(text: string, maxLines = CONF.REPLY_MAX_LINES) {
    const lines = (text || "").split("\n").filter(Boolean);
    if (lines.length <= maxLines) return text;
    const t = lines.slice(0, maxLines).join("\n").trim();
    return /[.!?…]$/.test(t) ? t : `${t}…`;
}
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(Number(value));
}
const IS_SERVICES_QUESTION = /(qué|que)\s+(servicios?|tratamientos?)\s+(ofre(?:ce|cen|s)|disponibles?|tienen?)/i;
const IS_GREETING = /^(hola|buenas|qué tal|que tal|buen d[ií]a|buenas tardes|buenas noches)[\s!.,¡¿?]*$/i;

/* ======== WhatsApp Cloud API (envío directo) ======== */
async function waSendText(params: {
    empresaId: number;
    phoneNumberId?: string;
    to: string;
    body: string;
}): Promise<string | null> {
    const { empresaId, phoneNumberId, to, body } = params;

    const wa = await prisma.whatsappAccount.findFirst({
        where: phoneNumberId ? { phoneNumberId } : { empresaId },
        select: { accessToken: true, phoneNumberId: true },
    });
    const pnid = phoneNumberId || wa?.phoneNumberId;
    const token = wa?.accessToken;
    if (!pnid || !token) return null;

    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(pnid)}/messages`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body },
        }),
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    return json?.messages?.[0]?.id ?? null;
}

async function sendAndPersist(params: {
    conversationId: number;
    empresaId: number;
    toPhone?: string;
    phoneNumberId?: string;
    texto: string;
    estado: "pendiente" | "respondido" | "en_proceso" | "requiere_agente";
}) {
    const { conversationId, empresaId, toPhone, phoneNumberId, texto, estado } = params;
    let wamid: string | null = null;
    if (toPhone) {
        try { wamid = await waSendText({ empresaId, phoneNumberId, to: toPhone, body: texto }); } catch { }
    }
    const msg = await prisma.message.create({
        data: { conversationId, empresaId, from: "bot", contenido: texto, externalId: wamid || undefined },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado } });
    return { messageId: msg.id, wamid: wamid || undefined };
}

/* ======== Memoria (conversation_state) ======== */
type DraftStage = "idle" | "offer" | "confirm";
type AgentState = {
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    hasGreeted?: boolean;
    draft?: {
        name?: string;
        phone?: string;
        procedureId?: number;
        procedureName?: string;
        whenISO?: string;
        durationMin?: number;
        stage?: DraftStage;
    };
    slotsCache?: {
        items: Array<{ startISO: string; endISO: string; label: string }>;
        expiresAt: string;
    };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
};

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}
async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({
        where: { conversationId },
        select: { data: true },
    });
    const data = (row?.data as AgentState | undefined) ?? {};
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    return data;
}
async function saveState(conversationId: number, data: AgentState) {
    const next = { ...data, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    await prisma.conversationState.upsert({
        where: { conversationId },
        create: { conversationId, data: next },
        update: { data: next },
    });
}
async function patchState(conversationId: number, patch: Partial<AgentState>) {
    const prev = await loadState(conversationId);
    await saveState(conversationId, { ...prev, ...patch });
}

/* ======== Historial compacto ======== */
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = CONF.MAX_HISTORY) {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where, orderBy: { timestamp: "desc" }, take, select: { from: true, contenido: true },
    });
    return rows.reverse().map((r) => ({
        role: (r.from === "client" ? "user" : "assistant") as "user" | "assistant",
        content: softTrim(r.contenido || "", 220),
    }));
}

/* ======== Resumen embebido ======== */
async function buildOrReuseSummary(args: {
    conversationId: number;
    kb: EsteticaKB;
    history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> {
    const { conversationId, kb, history } = args;
    const state = await loadState(conversationId);
    const fresh = state.summary && Date.now() < Date.parse(state.summary.expiresAt);
    if (fresh) return state.summary!.text;

    const services = (kb.procedures ?? [])
        .filter((s) => s.enabled !== false)
        .map((s) => {
            const desde = s.priceMin ? formatCOP(s.priceMin) : null;
            return desde ? `${s.name} (Desde ${desde} COP)` : s.name;
        })
        .join(" • ");

    const rules: string[] = [];
    if (kb.bufferMin) rules.push(`Buffer ${kb.bufferMin} min`);
    if (kb.defaultServiceDurationMin) rules.push(`Duración por defecto ${kb.defaultServiceDurationMin} min`);

    const logistics: string[] = [];
    if (kb.location?.name) logistics.push(`Sede: ${kb.location.name}`);
    if (kb.location?.address) logistics.push(`Dirección: ${kb.location.address}`);

    const base = [
        kb.businessName ? `Negocio: ${kb.businessName}` : "Negocio: Clínica estética",
        `TZ: ${kb.timezone}`,
        logistics.length ? logistics.join(" | ") : "",
        rules.length ? rules.join(" | ") : "",
        services ? `Servicios: ${services}` : "",
        kb.policies ? `Políticas: ${softTrim(kb.policies, 240)}` : "",
        kb.exceptions?.length ? `Excepciones próximas: ${kb.exceptions.slice(0, 2).map(e => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`).join(", ")}` : "",
        `Historial: ${history.map(h => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 110)).join(" | ")}`,
    ].filter(Boolean).join("\n");

    let compact = base;
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: CONF.MODEL,
            temperature: 0.1,
            max_tokens: 220,
            messages: [
                { role: "system", content: "Resume en 400–700 caracteres, bullets cortos, datos operativos y catálogo. Español neutro." },
                { role: "user", content: base.slice(0, 4000) },
            ],
        });
        compact = (resp?.choices?.[0]?.message?.content || base).trim().replace(/\n{3,}/g, "\n\n");
    } catch { }
    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    return compact;
}

/* ======== Intención ======== */
function detectIntent(text: string): "price" | "schedule" | "reschedule" | "cancel" | "info" | "other" {
    const t = (text || "").toLowerCase();
    if (/\b(precio|costo|valor|tarifa|cu[aá]nto)\b/.test(t)) return "price";
    if (/\b(horario|horarios|disponibilidad|cupo|agenda[rs]?|agendar|programar|reservar)\b/.test(t)) return "schedule";
    if (/\b(reagendar|cambiar|mover|otra hora|reprogramar)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";
    if (/\b(beneficios?|indicaciones|cuidados|contraindicaciones|en qu[eé] consiste|como funciona)\b/.test(t)) return "info";
    return "other";
}

/* ======== Variantes de tono ======== */
function varyPrefix(kind: "greet" | "offer" | "ask" | "ok"): string {
    const sets = {
        greet: ["¡Hola! 👋", "¡Qué gusto verte! 😊", "¡Hola, bienvenid@! ✨"],
        offer: ["Te cuento rápido:", "Mira, te resumo:", "Va súper corto:"],
        ask: ["¿Te parece si…?", "¿Te paso opciones…?", "¿Seguimos con…?"],
        ok: ["Perfecto ✅", "¡Listo! 🙌", "Genial ✨"],
    } as const;
    const arr = sets[kind];
    return arr[Math.floor(Math.random() * arr.length)];
}

/* ======== Catálogo → texto corto ======== */
function servicesOverview(kb: EsteticaKB, max = 4): string {
    const items = (kb.procedures ?? [])
        .filter(p => p.enabled)
        .slice(0, max)
        .map(p => {
            const price = p.priceMin ? ` (Desde ${formatCOP(p.priceMin)} (COP))` : "";
            return `• ${p.name}${price}`;
        })
        .join("\n");
    const tail = "¿Quieres horarios de alguno? 🗓️";
    return `${varyPrefix("offer")} Estos son algunos servicios:\n${items}\n\n${tail}`;
}

/* ======== CORE (export) ======== */
export async function handleEsteticaReply(args: {
    conversationId?: number;
    empresaId: number;
    contenido?: string;
    toPhone?: string;
    phoneNumberId?: string;
}): Promise<{
    estado: "pendiente" | "respondido" | "en_proceso" | "requiere_agente";
    mensaje: string;
    messageId?: number;
    wamid?: string;
    media?: any[];
}> {
    const { empresaId, contenido = "", toPhone, phoneNumberId } = args;

    // 1) Resolver conversación robustamente
    let convId: number | null =
        typeof args.conversationId === "number" && Number.isFinite(args.conversationId)
            ? Number(args.conversationId)
            : null;

    let conversacion: { id: number; phone: string; estado: string } | null = null;

    if (convId) {
        conversacion = await prisma.conversation.findUnique({
            where: { id: convId },
            select: { id: true, phone: true, estado: true },
        });
    }
    if (!conversacion && toPhone) {
        conversacion = await prisma.conversation.findFirst({
            where: { empresaId, phone: toPhone },
            select: { id: true, phone: true, estado: true },
            orderBy: { id: "desc" },
        });
    }
    if (!conversacion) {
        conversacion = await prisma.conversation.create({
            data: { empresaId, phone: toPhone || "", estado: "pendiente" },
            select: { id: true, phone: true, estado: true },
        });
    }
    convId = conversacion.id;

    // 2) KB
    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) {
        const txt = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
        const { messageId, wamid } = await sendAndPersist({
            conversationId: convId, empresaId, toPhone, phoneNumberId, texto: txt, estado: "requiere_agente",
        });
        return { estado: "requiere_agente", mensaje: txt, messageId, wamid, media: [] };
    }

    // 3) Estado
    let state = await loadState(convId);

    // 3.a Primera interacción: saludo una sola vez
    if (IS_GREETING.test(contenido.trim())) {
        const greetText = "¡Hola! 😊 ¿En qué puedo ayudarte hoy? Si tienes preguntas sobre nuestros tratamientos o quieres agendar, aquí estoy.";
        const { messageId, wamid } = await sendAndPersist({
            conversationId: convId, empresaId, toPhone, phoneNumberId, texto: greetText, estado: "respondido",
        });
        state.hasGreeted = true;
        await saveState(convId, state);
        return { estado: "respondido", mensaje: greetText, messageId, wamid, media: [] };
    }

    // 4) Historial + resumen embebido
    const history = await getRecentHistory(convId, undefined, CONF.MAX_HISTORY);
    const compactContext = await buildOrReuseSummary({ conversationId: convId, kb, history });

    // 5) Servicio + intención
    const match = resolveServiceName(kb, contenido || "");
    const service =
        match.procedure ??
        (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) ?? null : null);

    let intent = detectIntent(contenido);
    if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

    // 5.a Pregunta explícita por "servicios"
    if (IS_SERVICES_QUESTION.test(contenido)) {
        const texto = servicesOverview(kb, 4);
        const { messageId, wamid } = await sendAndPersist({
            conversationId: convId, empresaId, toPhone, phoneNumberId, texto, estado: "respondido",
        });
        return { estado: "respondido", mensaje: texto, messageId, wamid, media: [] };
    }

    // 6) Precio
    if (intent === "price") {
        if (service) {
            const priceLabel = serviceDisplayPrice(service) || (service.priceMin ? `Desde ${formatCOP(service.priceMin)} (COP)` : null);
            const dur = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;
            const dep = service.depositRequired ? formatCOP(service.depositAmount ?? null) : null;

            const piezas = [
                `${varyPrefix("offer")} *${service.name}*`,
                priceLabel ? `💵 ${priceLabel}` : "",
                `⏱️ Aprox. ${dur} min`,
                dep ? `🔐 Anticipo de ${dep}` : "",
            ].filter(Boolean);
            const tail = `${varyPrefix("ask")} ¿quieres ver horarios cercanos? 🗓️`;
            const texto = clampLines(closeNicely(`${piezas.join(" · ")}\n\n${tail}`));

            const { messageId, wamid } = await sendAndPersist({
                conversationId: convId, empresaId, toPhone, phoneNumberId, texto, estado: "en_proceso",
            });

            state.lastIntent = "price";
            state.lastServiceId = service.id;
            state.lastServiceName = service.name;
            await saveState(convId, state);

            return { estado: "en_proceso", mensaje: texto, messageId, wamid, media: [] };
        } else {
            const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
            const ask = `¿Sobre cuál? (Ej.: ${nombres}) 😊`;
            const { messageId, wamid } = await sendAndPersist({
                conversationId: convId, empresaId, toPhone, phoneNumberId, texto: ask, estado: "en_proceso",
            });
            return { estado: "en_proceso", mensaje: ask, messageId, wamid, media: [] };
        }
    }

    // 7) Horarios
    if (intent === "schedule" && (service || state.draft?.procedureId)) {
        const svc = service || kb.procedures.find((p) => p.id === state.draft?.procedureId)!;
        const duration = svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60;
        const tz = kb.timezone;
        const todayISO = tzFormat(utcToZonedTime(new Date(), tz), "yyyy-MM-dd", { timeZone: tz });

        const slotsByDay = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin: CONF.GRAN_MIN },
            todayISO,
            duration,
            CONF.DAYS_HORIZON,
            CONF.MAX_SLOTS
        );

        const flat = slotsByDay.flatMap(d => d.slots).slice(0, CONF.MAX_SLOTS);
        if (!flat.length) {
            const txt = "No veo cupos cercanos por ahora. ¿Quieres que te contacte un asesor para coordinar? 🤝";
            const { messageId, wamid } = await sendAndPersist({
                conversationId: convId, empresaId, toPhone, phoneNumberId, texto: txt, estado: "en_proceso",
            });
            return { estado: "en_proceso", mensaje: txt, messageId, wamid, media: [] };
        }

        const labeled = flat.map(s => {
            const d = new Date(s.startISO);
            const f = d.toLocaleString("es-CO", { weekday: "long", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
            return { startISO: s.startISO, endISO: s.endISO, label: f };
        });

        state.draft = { ...state.draft, procedureId: svc.id, procedureName: svc.name, durationMin: duration, stage: "offer" };
        state.lastIntent = "schedule";
        state.lastServiceId = svc.id;
        state.lastServiceName = svc.name;
        state.slotsCache = { items: labeled, expiresAt: nowPlusMin(10) };
        await saveState(convId, state);

        const bullets = labeled.map(l => `• ${l.label}`).join("\n");
        const texto = `Tengo disponibilidad cercana para *${svc.name}*:\n${bullets}\n\nElige una y dime tu *nombre* y *teléfono* para reservar ✅`;
        const { messageId, wamid } = await sendAndPersist({
            conversationId: convId, empresaId, toPhone, phoneNumberId, texto, estado: "en_proceso",
        });
        return { estado: "en_proceso", mensaje: texto, messageId, wamid, media: [] };
    }

    // 8) Doble confirmación
    const nameMatch = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i.exec(contenido);
    const phoneMatch = /(\+?57)?\s?(\d{10})\b/.exec(contenido.replace(/[^\d+]/g, " "));
    const hhmm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(contenido);

    if ((nameMatch || phoneMatch || hhmm) && state.draft?.stage === "offer" && (state.draft.procedureId || service?.id)) {
        let chosen = state.slotsCache?.items?.[0];
        if (hhmm && state.slotsCache?.items?.length) {
            const hh = `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
            const hit = state.slotsCache.items.find(s => new Date(s.startISO).toISOString().slice(11, 16) === hh);
            if (hit) chosen = hit;
        }
        if (!chosen && state.slotsCache?.items?.length) chosen = state.slotsCache.items[0];

        const draft = {
            ...state.draft,
            name: state.draft.name ?? (nameMatch ? nameMatch[2].trim().replace(/\s+/g, " ").replace(/^\p{L}/u, (c) => c.toUpperCase()) : undefined),
            phone: state.draft.phone ?? (phoneMatch ? phoneMatch[2] : undefined),
            whenISO: state.draft.whenISO ?? chosen?.startISO,
            stage: "confirm" as DraftStage,
        };
        state.draft = draft;
        await saveState(convId, state);

        const local = draft.whenISO ? new Date(draft.whenISO) : null;
        const fecha = local
            ? local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit" })
            : "fecha por confirmar";
        const hora = local
            ? local.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false })
            : "hora por confirmar";

        const resumen =
            `${varyPrefix("ok")} Estoy listo para reservar. ¿Confirmas?\n` +
            `• Procedimiento: ${draft.procedureName}\n` +
            `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
            `• Nombre: ${draft.name ?? "—"}\n` +
            `• Teléfono: ${draft.phone ?? "—"}\n\n` +
            `Responde *"confirmo"* y hago la reserva 📅`;

        const { messageId, wamid } = await sendAndPersist({
            conversationId: convId, empresaId, toPhone, phoneNumberId, texto: resumen, estado: "en_proceso",
        });
        return { estado: "en_proceso", mensaje: resumen, messageId, wamid, media: [] };
    }

    if (/^confirmo\b/i.test(contenido.trim()) && state.draft?.stage === "confirm" && state.draft.whenISO) {
        try {
            const svc = kb.procedures.find(p => p.id === (state.draft?.procedureId ?? 0));
            const endISO = new Date(addMinutes(new Date(state.draft.whenISO), state.draft.durationMin ?? (svc?.durationMin ?? 60))).toISOString();

            await createAppointmentSafe({
                empresaId,
                vertical: kb.vertical,
                timezone: kb.timezone,
                procedureId: state.draft.procedureId ?? null,
                serviceName: state.draft.procedureName || (svc?.name ?? "Procedimiento"),
                customerName: state.draft.name || "Cliente",
                customerPhone: state.draft.phone || "",
                startISO: state.draft.whenISO,
                endISO,
                notes: "Agendado por IA",
                source: "ai",
            });

            const ok = `¡Hecho! Tu cita quedó confirmada ✅. Te llegará un recordatorio.`;
            const { messageId, wamid } = await sendAndPersist({
                conversationId: convId, empresaId, toPhone, phoneNumberId, texto: ok, estado: "respondido",
            });

            state.draft = { stage: "idle" };
            await saveState(convId, state);

            return { estado: "respondido", mensaje: ok, messageId, wamid, media: [] };
        } catch {
            const fail = `Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?`;
            const { messageId, wamid } = await sendAndPersist({
                conversationId: convId, empresaId, toPhone, phoneNumberId, texto: fail, estado: "en_proceso",
            });
            return { estado: "en_proceso", mensaje: fail, messageId, wamid, media: [] };
        }
    }

    // 9) Respuesta libre (evitar segundo saludo si ya saludamos)
    const noRepeatGreet = state.hasGreeted
        ? "\nMuy importante: ya saludaste antes, evita saludar de nuevo y ve directo al punto."
        : "";

    const system = [
        `Eres un asesor de clínica estética en ${kb.timezone}. Tono humano, cálido, breve, con 1–3 emojis. Respuestas únicas (evita plantillas).`,
        `Si el usuario pide *precios*, usa únicamente los valores reales del catálogo (priceMin/priceMax). Formato: "Desde $X (COP)".`,
        `Si pide *horarios*, ofrece slots cercanos (la función interna ya se ejecuta según intención).`,
        `Si detectas intención clara de agendar, pide nombre y teléfono y haz una confirmación final antes de reservar.`,
        `Si el modelo inventa montos no presentes, reemplázalos por "consulta por precio".`,
        `Resumen operativo + catálogo:\n${compactContext}`,
        noRepeatGreet,
    ].join("\n");

    const svcLine = service
        ? `Servicio en contexto: ${service.name}`
        : (state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : "");
    const userCtx = [svcLine, contenido].filter(Boolean).join("\n");

    let texto = "";
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: CONF.MODEL,
            temperature: CONF.TEMPERATURE,
            max_tokens: 180,
            messages: [{ role: "system", content: system }, { role: "user", content: userCtx }],
        });
        texto = (resp?.choices?.[0]?.message?.content || "").trim();
    } catch {
        texto = "Te ayudo con info de los tratamientos y, si quieres, vemos horarios para agendar. 🙂";
    }
    texto = closeNicely(texto);
    texto = clampLines(texto, CONF.REPLY_MAX_LINES);
    if (!/precio|costo|valor|tarifa|cu[aá]nto/i.test(contenido)) {
        if (KB_MONEY_RE.test(texto)) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
    }

    const { messageId, wamid } = await sendAndPersist({
        conversationId: convId, empresaId, toPhone, phoneNumberId, texto, estado: "respondido",
    });

    if (service) {
        state.lastServiceId = service.id;
        state.lastServiceName = service.name;
    }
    state.lastIntent = intent === "other" ? state.lastIntent : intent;
    await saveState(convId, state);

    return { estado: "respondido", mensaje: texto, messageId, wamid, media: [] };
}

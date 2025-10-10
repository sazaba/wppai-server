// utils/ai/strategies/estetica.strategy.ts
import axios from "axios";
import prisma from "../../../lib/prisma";
import { openai } from "../../../lib/openai";
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
} from "@prisma/client";

import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";

// === Estética (KB + Agenda)
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
    type Slot,
} from "./esteticaModules/schedule/estetica.schedule";

import { formatInTimeZone } from "date-fns-tz";

/* ──────────────────────────────────────────────────────────
   Config
────────────────────────────────────────────────────────── */
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);

const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 180);
const LLM_MODEL = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
const LLM_TEMP = Number(process.env.IA_TEMPERATURE ?? 0.5);

const KB_TTL_MS = Number(process.env.IA_KB_TTL_MS ?? 5 * 60 * 1000);
const SLOTS_GRANULARITY_MIN = Number(process.env.IA_SLOTS_GRANULARITY_MIN ?? 15);
const SLOTS_DAYS_HORIZON = Number(process.env.IA_SLOTS_DAYS_HORIZON ?? 14);
const SLOTS_TAKE = Number(process.env.IA_SLOTS_TAKE ?? 6);

/* ──────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────── */
const processedInbound = new Map<number, number>();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const rand = <T>(arr: T[], fb?: T) => arr.length ? arr[Math.floor(Math.random() * arr.length)] : (fb as T);
const EMOJI_WARM = ["🙂", "✨", "😊", "👌", "💬", "🫶", "💡"];
const EMOJI_TIME = ["⏰", "🗓️", "📅"];
const EMOJI_OK = ["✅", "👌", "👍"];

function seenInboundRecently(id: number, win = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now(); const prev = processedInbound.get(id);
    if (prev && now - prev <= win) return true;
    processedInbound.set(id, now); return false;
}

function normalizeToE164(n: string) { return String(n || "").replace(/[^\d]/g, ""); }

function clampConcise(text: string, maxLines = IA_MAX_LINES) {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const lines = t ? t.split("\n").filter(Boolean) : [];
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function formatConcise(text: string) {
    let t = (text || "").trim();
    if (!t) return "¿En qué te ayudo?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    return clampConcise(t);
}
function closeNicely(raw: string) {
    let t = (raw || "").trim();
    if (!t) return t;
    if (/[.!?…]\s*$/.test(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    if (!t) return raw.trim();
    return `${t}…`;
}

/* ──────────────────────────────────────────────────────────
   Imagen & voz
────────────────────────────────────────────────────────── */
function mentionsImageExplicitly(t: string) {
    const s = (t || "").toLowerCase();
    return /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s)
        || /(mira|revisa|checa|verifica)\s+la\s+(foto|imagen)/.test(s)
        || /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s)
        || /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s);
}
async function pickImageForContext(opts: {
    conversationId: number; directUrl?: string | null; userText: string; caption: string; referenceTs: Date;
}) {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts;
    if (directUrl) return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "" };
    if (!userText) return { url: null as string | null, noteToAppend: "" };

    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId, from: MessageFrom.client, mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs }
        },
        orderBy: { timestamp: "desc" }, select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        const note = veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "";
        return { url: String(veryRecent.mediaUrl), noteToAppend: note };
    }
    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId, from: MessageFrom.client, mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs }
            },
            orderBy: { timestamp: "desc" }, select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            const note = referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "";
            return { url: String(referenced.mediaUrl), noteToAppend: note };
        }
    }
    return { url: null as string | null, noteToAppend: "" };
}

/* ──────────────────────────────────────────────────────────
   Persistencia + WA
────────────────────────────────────────────────────────── */
async function persistBotReply({
    conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId,
}: {
    conversationId: number; empresaId: number; texto: string; nuevoEstado: ConversationEstado;
    to?: string | null; phoneNumberId?: string | null;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            const resp = await Wam.sendWhatsappMessage({
                empresaId, to: normalizeToE164(to), body: texto, phoneNumberIdHint: phoneNumberId || undefined,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
        } catch (e: any) {
            console.error("[WAM send error]", e?.response?.data || e?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* ──────────────────────────────────────────────────────────
   Historial compacto
────────────────────────────────────────────────────────── */
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 12) {
    const rows = await prisma.message.findMany({
        where: excludeMessageId ? { conversationId, id: { not: excludeMessageId } } : { conversationId },
        orderBy: { timestamp: "asc" },
        take,
        select: { from: true, contenido: true },
    });
    return rows.map((r) => ({
        role: r.from === MessageFrom.client ? "user" : "assistant",
        content: (r.contenido || "").slice(0, 300),
    }));
}

/* ──────────────────────────────────────────────────────────
   Intents suaves + extractores
────────────────────────────────────────────────────────── */
const isCatalogQuery = (t: string) => {
    const s = ` ${(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()} `;
    const nouns = ["servicio", "servicios", "procedimiento", "procedimientos", "tratamiento", "tratamientos", "catalogo", "catálogo"];
    const intents = ["que ", "qué ", "cuales", "cuáles", "lista", "disponible", "ofrecen", "tienes", "hay", "oferta", "precios", "precio", "costos", "tarifas"];
    return nouns.some(k => s.includes(` ${k} `)) || intents.some(k => s.includes(k));
};
const asksPrice = (t: string) => /\b(precio|precios|costo|costos|valor|tarifa|tarifas)\b/i.test((t || "").toLowerCase());
const wantsSchedule = (t: string) => /\b(horario|horarios|disponibilidad|agenda|agendar|agéndame|cita|turno|reservar|programar)\b/i.test(t || "");
const isSvcInfo = (t: string) =>
    /\b(beneficios?|ventajas?|resultados?)\b/i.test(t) ||
    /\b(preparaci[oó]n|indicaciones|antes de|previo|en que consiste|en qué consiste|como funciona)\b/i.test(t) ||
    /\b(contraindicaciones?|riesgos?|efectos?\s+secundarios?)\b/i.test(t) ||
    /\b(cuidados?|post\s*cuidado|despu[eé]s|postoperatorio)\b/i.test(t);

function extractPhone(text: string): string | undefined {
    const clean = text.replace(/[^\d+]/g, " ");
    const m = /(\+?57)?\s*(\d{10})\b/.exec(clean);
    return m ? m[2] : undefined;
}
function extractName(text: string): string | undefined {
    const m = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i.exec(text);
    if (m) return m[2].trim().replace(/\s+/g, " ").replace(/^[a-záéíóúñ]/i, (c) => c.toUpperCase());
    return undefined;
}
function extractTime(text: string): string | undefined {
    const m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

/* ──────────────────────────────────────────────────────────
   Estado de conversación (preferido) + fallback por tag
────────────────────────────────────────────────────────── */
// Si tienes una tabla conversation_state, úsala; si no, nos vamos al tag simple.
type Draft = {
    serviceId?: number;
    whenISO?: string;   // ISO con zona (-05:00)
    name?: string;
    phone?: string;
    stage?: "oferta" | "confirm";
};
async function readState(conversationId: number): Promise<Draft> {
    try {
        // @ts-ignore tabla opcional
        const row = await (prisma as any).conversationState?.findUnique({
            where: { conversationId },
            select: { data: true },
        });
        if (row?.data) return row.data as Draft;
    } catch { }
    // fallback: intenta leer del último mensaje del bot
    const lastBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { id: "desc" }, select: { contenido: true },
    });
    const d: Draft = {};
    if (lastBot?.contenido) {
        const m = /\[CTX svc:(\d+)\]/.exec(lastBot.contenido);
        if (m) d.serviceId = Number(m[1]);
    }
    return d;
}
async function writeState(conversationId: number, data: Draft) {
    try {
        // @ts-ignore tabla opcional
        await (prisma as any).conversationState?.upsert({
            where: { conversationId },
            create: { conversationId, data },
            update: { data },
        });
    } catch {
        // si no existe la tabla, no hacemos nada
    }
}

/* ──────────────────────────────────────────────────────────
   KB híbrido cacheado (+ preview de horarios)
────────────────────────────────────────────────────────── */
type KBContext = { text: string; kb: EsteticaKB; builtAt: number; hash: string; slotsPreview?: string };
const KB_CACHE = new Map<number, KBContext>(); // empresaId → contexto

function hashKB(kb: EsteticaKB) {
    const payload = JSON.stringify({
        empresaId: kb.empresaId, timezone: kb.timezone, bufferMin: kb.bufferMin, policies: kb.policies ?? "",
        staff: (kb.staff || []).map(s => [s.id, s.name, s.role, s.active]),
        exceptions: (kb.exceptions || []).map(e => [e.dateISO, e.isOpen, e.start1, e.end1, e.start2, e.end2]),
        procedures: (kb.procedures || []).map(p => [p.id, p.name, p.enabled, p.durationMin, p.priceMin, p.priceMax, p.depositRequired]),
        location: kb.location ?? {},
    });
    let h = 0; for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) | 0; return String(h);
}
function buildKBText(kb: EsteticaKB, slotsPreview?: string) {
    const procs = (kb.procedures || [])
        .filter(p => p && p.enabled !== false)
        .map(p => {
            const from = serviceDisplayPrice(p as any);
            const dur = p.durationMin ? ` · ${p.durationMin} min` : "";
            return `- ${p.name}${from ? ` (Desde ${from})` : ""}${dur}`;
        }).join("\n");

    const staff = (kb.staff || []).map(s => `- ${s.name} (${s.role}${!s.active ? ", inactivo" : ""})`).join("\n");

    const loc = kb.location ? [
        kb.location.name ? `Sede: ${kb.location.name}` : "",
        kb.location.address ? `Dirección: ${kb.location.address}` : "",
        kb.location.mapsUrl ? `Maps: ${kb.location.mapsUrl}` : "",
    ].filter(Boolean).join(" | ") : "";

    return [
        `EmpresaId: ${kb.empresaId}`,
        `Zona horaria: ${kb.timezone} · Buffer: ${kb.bufferMin} min`,
        kb.policies ? `Políticas: ${kb.policies}` : "",
        loc ? `Ubicación: ${loc}` : "",
        staff ? `\nStaff:\n${staff}` : "",
        procs ? `\nProcedimientos:\n${procs}` : "",
        slotsPreview ? `\nDisponibilidad próxima (vista previa):\n${slotsPreview}` : "",
    ].filter(Boolean).join("\n");
}

async function getOrBuildKBContext(empresaId: number): Promise<KBContext | null> {
    const now = Date.now();
    const cached = KB_CACHE.get(empresaId);
    if (cached && now - cached.builtAt <= KB_TTL_MS) return cached;

    const kb = await loadEsteticaKB({ empresaId, vertical: "estetica" });
    if (!kb) return null;

    // Preview de horarios (genérico) para que el LLM “sepa” que hay cupos
    const tz = kb.timezone || "America/Bogota";
    const dateISO = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
    const duration = kb.defaultServiceDurationMin ?? 45;
    let slotsPreview = "";
    try {
        const groups = await getNextAvailableSlots(
            { empresaId, vertical: "estetica", timezone: tz, bufferMin: kb.bufferMin ?? 10, granularityMin: SLOTS_GRANULARITY_MIN },
            dateISO, duration, SLOTS_DAYS_HORIZON, SLOTS_TAKE
        );
        if (groups.length) {
            slotsPreview = groups.map(g => {
                const xs = g.slots.slice(0, 3).map(s => s.startISO.slice(11, 16)).join(", ");
                return `• ${g.date}: ${xs}${g.slots.length > 3 ? "…" : ""}`;
            }).join("\n");
        }
    } catch {/* si falla, seguimos sin preview */ }

    const text = buildKBText(kb, slotsPreview);
    const ctx: KBContext = { text, kb, builtAt: now, hash: hashKB(kb), slotsPreview };
    KB_CACHE.set(empresaId, ctx);
    return ctx;
}

/* ──────────────────────────────────────────────────────────
   Respuesta principal (híbrido natural + flujo agenda suave)
────────────────────────────────────────────────────────── */
export type IAReplyResult = {
    estado: ConversationEstado; mensaje: string; messageId?: number; wamid?: string; media?: any[];
};

export async function handleEsteticaReply(args: {
    chatId: number; empresaId: number; mensajeArg?: string; toPhone?: string | null; phoneNumberId?: string | null;
}): Promise<IAReplyResult> {
    const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = args;

    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId }, select: { id: true, estado: true, phone: true },
    });
    if (!conversacion) return { estado: ConversationEstado.pendiente, mensaje: "" };

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: { id: true, mediaType: true, mediaUrl: true, caption: true, isVoiceNote: true, transcription: true, contenido: true, mimeType: true, timestamp: true },
    });
    if (last?.id && seenInboundRecently(last.id)) return { estado: conversacion.estado, mensaje: "" };

    const kbCtx = await getOrBuildKBContext(empresaId);
    if (!kbCtx) {
        const saved = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: "Ahora mismo no tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }
    const kb = kbCtx.kb;

    // Texto del usuario (o transcripción)
    let userText = (mensajeArg || last?.contenido || "").trim();
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || "").trim();
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null;
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), { responseType: "arraybuffer", timeout: 30000 });
                    audioBuf = Buffer.from(data);
                }
                if (audioBuf) {
                    const name = last.mimeType?.includes("mpeg") ? "audio.mp3"
                        : last.mimeType?.includes("wav") ? "audio.wav"
                            : last.mimeType?.includes("m4a") ? "audio.m4a"
                                : last.mimeType?.includes("webm") ? "audio.webm"
                                    : "audio.ogg";
                    transcript = await transcribeAudioBuffer(audioBuf, name);
                    if (transcript) await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } });
                }
            } catch { }
        }
        if (transcript) userText = transcript;
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();
    if (isImage && !caption && !userText) { await sleep(IMAGE_WAIT_MS); return { estado: conversacion.estado, mensaje: "" }; }

    // Estado previo + extracción de datos
    const draft = await readState(chatId);
    const svcHit = resolveServiceName(kb, userText || caption || "");
    if (svcHit?.procedure?.id) draft.serviceId = svcHit.procedure.id;

    const name = extractName(userText); if (name) draft.name = name;
    const phone = extractPhone(userText); if (phone) draft.phone = phone;
    const hhmm = extractTime(userText);

    // Contexto de servicio (si no vino nombre pero veníamos hablando de uno)
    const svc = draft.serviceId ? (kb.procedures || []).find(p => p.id === draft.serviceId) || null : null;

    // ── 1) Preguntas de precios (se sale del flujo)
    if (asksPrice(userText || caption || "")) {
        const list = (kb.procedures || [])
            .filter(p => p.enabled !== false)
            .slice(0, 24)
            .map(p => `• ${p.name}${serviceDisplayPrice(p as any) ? ` (Desde ${serviceDisplayPrice(p as any)})` : ""}`)
            .join("\n");

        const txt = `Te cuento precios *en COP* ${rand(EMOJI_WARM)}:\n\n${list}\n\nSi decides por uno, te paso horarios ${rand(EMOJI_TIME)}.`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await writeState(chatId, draft);
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // ── 2) Info natural de procedimiento (beneficios, en qué consiste, etc.)
    if (svc && isSvcInfo(userText || caption || "")) {
        const bits: string[] = [];
        if (svc.prepInstructions) bits.push(`• *Indicaciones previas:* ${svc.prepInstructions}`);
        if (svc.postCare) bits.push(`• *Cuidados posteriores:* ${svc.postCare}`);
        if (svc.contraindications) bits.push(`• *Contraindicaciones:* ${svc.contraindications}`);
        if (!bits.length) bits.push("• Recomendación general: llega con la piel limpia, evita exfoliantes fuertes 48–72 h antes y usa protector solar.");

        const from = serviceDisplayPrice(svc);
        const txt = `${rand(["Sobre", "En resumen de", "Te explico brevemente"])} *${svc.name}*${from ? ` (Desde ${from})` : ""} ${rand(EMOJI_WARM)}:\n${bits.join("\n")}\n\n¿Quieres que te proponga horarios ${rand(EMOJI_TIME)}?`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await writeState(chatId, draft);
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // ── 3) Ver horarios (sin forzar booking)
    if (wantsSchedule(userText || caption || "")) {
        const tz = kb.timezone || "America/Bogota";
        const bufferMin = kb.bufferMin ?? 10;
        const durationMin = svc?.durationMin ?? kb.defaultServiceDurationMin ?? 45;

        const nowLocalISO = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");

        const found = await getNextAvailableSlots(
            { empresaId, vertical: "estetica", timezone: tz, bufferMin, granularityMin: SLOTS_GRANULARITY_MIN },
            nowLocalISO, durationMin, SLOTS_DAYS_HORIZON, SLOTS_TAKE
        );

        if (found.length) {
            const pretty = found.map((day) => {
                const times = day.slots.slice(0, 3).map((s) => s.startISO.slice(11, 16)).join(", ");
                return `• ${day.date}: ${times}${day.slots.length > 3 ? "…" : ""}`;
            }).join("\n");

            const head = svc ? `Para *${svc.name}* tengo:` : "Tengo disponibilidad cercana:";
            const txt = `${head}\n\n${pretty}\n\nElige una y dime tu *nombre* y *teléfono* para reservar ${rand(EMOJI_OK)}.`;
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            await writeState(chatId, { ...draft, stage: "oferta" });
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }

        const savedNo = await persistBotReply({
            conversationId: chatId, empresaId,
            texto: `Por ahora no veo cupos cercanos. Si quieres, te contacto con un asesor para coordinar un horario que te sirva ${rand(EMOJI_WARM)}.`,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await writeState(chatId, draft);
        return { estado: ConversationEstado.en_proceso, mensaje: savedNo.texto, messageId: savedNo.messageId, wamid: savedNo.wamid, media: [] };
    }

    // ── 4) Booking suave: solo si tenemos todo (svc, hora, nombre, teléfono)
    if (svc && draft.stage === "oferta" && hhmm) {
        // fecha ancla hoy en TZ y construimos whenISO “hoy HH:mm” si no vino explícito con fecha
        const tz = kb.timezone || "America/Bogota";
        const todayISO = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
        draft.whenISO = `${todayISO}T${hhmm}:00${formatInTimeZone(new Date(), tz, "XXX")}`;
    }

    if (svc && draft.whenISO && draft.name && draft.phone && draft.stage !== "confirm") {
        draft.stage = "confirm";
        await writeState(chatId, draft);

        const localDate = draft.whenISO.slice(0, 10);
        const localTime = draft.whenISO.slice(11, 16);
        const txt =
            `¿Confirmamos esta reserva ${rand(EMOJI_OK)}?\n` +
            `• Servicio: *${svc.name}*\n` +
            `• Fecha/Hora: *${localDate} ${localTime}*\n` +
            `• Nombre: *${draft.name}*\n` +
            `• Teléfono: *${draft.phone}*\n\n` +
            `Si está correcto, responde *confirmo*.`;

        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // ── 5) Confirmación explícita
    if (/^confirmo\b/i.test(userText) && draft.stage === "confirm" && svc && draft.whenISO && draft.name && draft.phone) {
        try {
            // parse cuando viene con offset; createAppointmentSafe convierte a UTC y valida solape
            const duration = svc.durationMin ?? kb.defaultServiceDurationMin ?? 45;
            const startISO = draft.whenISO;
            const endISO = startISO.replace(/T(\d{2}):(\d{2})/, (_m, h, m) => {
                const mins = Number(h) * 60 + Number(m) + duration;
                const hh = String(Math.floor(mins / 60)).padStart(2, "0");
                const mm = String(mins % 60).padStart(2, "0");
                return `T${hh}:${mm}`;
            });

            await createAppointmentSafe({
                empresaId,
                vertical: "estetica",
                timezone: kb.timezone,
                procedureId: svc.id,
                serviceName: svc.name,
                customerName: draft.name!,
                customerPhone: draft.phone!,
                startISO,
                endISO,
                notes: null,
                source: "ai",
            });

            const localDate = draft.whenISO.slice(0, 10);
            const localTime = draft.whenISO.slice(11, 16);
            const ok = `¡Listo! Tu cita de *${svc.name}* quedó para **${localDate} ${localTime}**. ${rand(EMOJI_OK)}`;
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: ok, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            await writeState(chatId, {}); // limpiar estado
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        } catch (e: any) {
            const fail = `Ese horario acaba de ocuparse. ¿Te comparto opciones cercanas ${rand(EMOJI_TIME)}?`;
            const saved = await persistBotReply({
                conversationId: chatId, empresaId, texto: fail, nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone, phoneNumberId,
            });
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    // ── 6) Catálogo simple (si lo piden)
    if (isCatalogQuery(userText || caption || "")) {
        const list = (kb.procedures || [])
            .filter(p => p.enabled !== false)
            .slice(0, 24)
            .map(p => `• ${p.name}${serviceDisplayPrice(p as any) ? ` (Desde ${serviceDisplayPrice(p as any)})` : ""}`)
            .join("\n");
        const txt = `Tenemos ${rand(EMOJI_WARM)}:\n\n${list}\n\n¿Quieres ver horarios para alguno ${rand(EMOJI_TIME)}?`;
        const saved = await persistBotReply({
            conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone, phoneNumberId,
        });
        await writeState(chatId, draft);
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    /* ── 7) Conversación libre + KB (tono humano, sin plantillas) ───────────────── */
    const system = [
        "Eres un asesor humano de una clínica estética.",
        "Responde de forma natural, breve (2–5 líneas), específica y empática.",
        "Usa emojis con moderación y variedad; evita sonar a bot o usar plantillas fijas.",
        "No inventes precios: si el usuario no preguntó por precio, evita mencionar montos.",
        "Si detectas intención clara de agendar, ofrece horarios concretos.",
        "",
        "=== CONOCIMIENTO REAL DE LA CLÍNICA ===",
        kbCtx.text,
        "=== FIN DEL CONOCIMIENTO ===",
    ].join("\n");

    let effectiveImageUrl = isImage ? imageUrl : null;
    let textForLLM = (userText || caption || "Hola").trim();
    if (!effectiveImageUrl && textForLLM) {
        const picked = await pickImageForContext({ conversationId: chatId, directUrl: null, userText: textForLLM, caption, referenceTs });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
    }

    const history = await getRecentHistory(chatId, last?.id, 12);
    const messages: any[] = [{ role: "system", content: system }, ...history];
    if (effectiveImageUrl) {
        messages.push({ role: "user", content: [{ type: "text", text: textForLLM }, { type: "image_url", image_url: { url: effectiveImageUrl } }] });
    } else {
        messages.push({ role: "user", content: textForLLM });
    }

    let texto = "";
    try {
        const resp = await (openai.chat.completions.create as any)({
            model: LLM_MODEL, temperature: LLM_TEMP, max_tokens: IA_MAX_TOKENS, messages,
        });
        texto = resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch {
        texto = `Te oriento con gusto ${rand(EMOJI_WARM)}. Si quieres, también te paso horarios.`;
    }

    if (!asksPrice(userText || caption || "")) {
        if (KB_MONEY_RE.test(texto)) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
    }
    texto = formatConcise(closeNicely(texto));

    const saved = await persistBotReply({
        conversationId: chatId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone, phoneNumberId,
    });
    await writeState(chatId, draft);

    return { estado: ConversationEstado.respondido, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
}

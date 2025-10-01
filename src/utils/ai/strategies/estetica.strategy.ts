// utils/ai/strategies/estetica.ts (handler principal)

import axios from "axios";
import prisma from "../../../lib/prisma";
import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";
import { ConversationEstado, MessageFrom } from "@prisma/client";

import { loadApptContext, type EsteticaCtx } from "./esteticaModules/estetica.rag";
import { runEsteticaAgent } from "./esteticaModules/assistant/ai.agent";

export type IAReplyResult = {
    estado: ConversationEstado;
    mensaje?: string;
    motivo?: "confianza_baja" | "palabra_clave" | "reintentos";
    messageId?: number;
    wamid?: string;
    media?: Array<{ productId: number; imageUrl: string; wamid?: string }>;
};

/* =================== De-dup y utilidades =================== */

const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);

const processedInbound = new Map<number, number>();
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}

function softTrim(s?: string | null, max = 220) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}

function normalizeToE164(n: string) {
    return String(n || "").replace(/[^\d]/g, "");
}

async function persistBotReply({
    conversationId,
    empresaId,
    texto,
    nuevoEstado,
    to,
    phoneNumberId,
}: {
    conversationId: number;
    empresaId: number;
    texto: string;
    nuevoEstado: ConversationEstado;
    to?: string;
    phoneNumberId?: string;
}) {
    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });

    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    });

    let wamid: string | undefined;
    if (to && String(to).trim()) {
        try {
            let phoneId = phoneNumberId;
            if (!phoneId) {
                const acc = await prisma.whatsappAccount.findFirst({
                    where: { empresaId },
                    select: { phoneNumberId: true },
                });
                phoneId = acc?.phoneNumberId;
            }
            const resp = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneId,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
            if (wamid) {
                await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
            }
        } catch (e: any) {
            console.warn("[WA] sendWhatsappMessage fallo:", e?.response?.data || e?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

/* =============== Historial reciente para el agente =============== */

async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
    const where: any = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };
    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take,
        select: { from: true, contenido: true },
    });
    return rows
        .reverse()
        .map((r) => ({
            role: r.from === MessageFrom.client ? ("user" as const) : ("assistant" as const),
            content: softTrim(r.contenido || "", 220),
        }));
}

/* ========================= ENTRY ========================= */

const USE_AGENT = true; // 🔥 siempre orquestado

export async function handleEsteticaReply(opts: {
    chatId: number;
    empresaId: number;
    mensajeArg?: string;
    toPhone?: string;
    phoneNumberId?: string;
    apptConfig?: any;
}): Promise<IAReplyResult | null> {
    const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = opts;

    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true, nombre: true },
    });
    if (!conversacion) return null;

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: {
            id: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            isVoiceNote: true,
            transcription: true,
            contenido: true,
            mimeType: true,
            timestamp: true,
        },
    });
    if (last?.id && seenInboundRecently(last.id)) return null;

    const ctx: EsteticaCtx = await loadApptContext(empresaId, opts.apptConfig);

    // === Voz → texto
    let userText = (mensajeArg || "").trim();
    if (!userText && last?.isVoiceNote) {
        let transcript = (last.transcription || "").trim();
        if (!transcript) {
            try {
                let audioBuf: Buffer | null = null;
                if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
                    const { data } = await axios.get(String(last.mediaUrl), {
                        responseType: "arraybuffer",
                        timeout: 30000,
                    });
                    audioBuf = Buffer.from(data);
                }
                if (audioBuf) {
                    const name =
                        last.mimeType?.includes("mpeg")
                            ? "audio.mp3"
                            : last.mimeType?.includes("wav")
                                ? "audio.wav"
                                : last.mimeType?.includes("m4a")
                                    ? "audio.m4a"
                                    : last.mimeType?.includes("webm")
                                        ? "audio.webm"
                                        : "audio.ogg";
                    transcript = await transcribeAudioBuffer(audioBuf, name);
                    if (transcript) {
                        await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } });
                    }
                }
            } catch {
                /* noop */
            }
        }
        if (transcript) userText = transcript;
    }
    if (!userText && last?.contenido) userText = String(last.contenido || "").trim();

    // Si no hay nada que procesar, corta acá
    if (!userText) return null;

    // ===== Orquestación con el agente =====
    if (USE_AGENT) {
        const history = await getRecentHistory(chatId, last?.id, 10);
        const turns = [...history, { role: "user" as const, content: userText }];

        try {
            const texto =
                (await runEsteticaAgent(ctx, turns, {
                    phone: toPhone ?? conversacion.phone ?? undefined,
                    conversationId: chatId, // <- importante para book()
                })) || "¿Quieres que te comparta horarios desde mañana o prefieres más información?";

            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.respondido,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        } catch (e) {
            console.warn("[AI-Agent] error:", e);
            const fallback =
                "Lo siento, tuve un error procesando tu consulta. ¿Quieres que lo intente de nuevo?";
            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: fallback,
                nuevoEstado: ConversationEstado.respondido,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return {
                estado: ConversationEstado.respondido,
                mensaje: saved.texto,
                messageId: saved.messageId,
                wamid: saved.wamid,
                media: [],
            };
        }
    }

    // (No debería entrar aquí con USE_AGENT=true)
    return null;
}

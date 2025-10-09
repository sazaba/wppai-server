// // utils/ai/strategies/estetica.strategy.ts
// import axios from "axios";
// import prisma from "../../../lib/prisma";
// import type { Prisma } from "@prisma/client";
// import { openai } from "../../../lib/openai";
// import {
//     ConversationEstado,
//     MediaType,
//     MessageFrom,
//     AppointmentStatus,
//     AppointmentVertical,
// } from "@prisma/client";
// import * as Wam from "../../../services/whatsapp.service";
// import { transcribeAudioBuffer } from "../../../services/transcription.service";
// import type { IAReplyResult } from "../../handleIAReply.ecommerce";

// import { Logger } from "../../ai/strategies/esteticaModules/log";
// const log = Logger.child("estetica.strategy");

// // === Módulos de Estética (KB + Agenda + Fechas) ===
// import {
//     loadEsteticaKB,
//     resolveServiceName,
//     serviceDisplayPrice,
//     MONEY_RE as KB_MONEY_RE,
// } from "./esteticaModules/domain/estetica.kb";
// import {
//     findNextSlots,
//     bookAppointment,
//     rescheduleAppointment,
//     cancelAppointment,
//     type SlotView,
// } from "./esteticaModules/schedule/estetica.schedule";
// import {
//     parseRelativeDateText,
//     fromLocalTZToUTC,
//     fromUTCtoLocalTZ,
//     combineLocalDateTime,
//     parseHHMM,
// } from "./esteticaModules/datetime";

// /** ===== Config imagen/texto ===== */
// const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
// const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
// const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);
// const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);

// /** ===== Respuesta breve ===== */
// const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
// const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000);
// const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 160);
// const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? "0") === "1";

// /** ===== Idempotencia por inbound (sin DB) ===== */
// const processedInbound = new Map<number, number>(); // messageId -> ts
// function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
//     const now = Date.now();
//     const prev = processedInbound.get(messageId);
//     if (prev && now - prev <= windowMs) return true;
//     processedInbound.set(messageId, now);
//     return false;
// }

// /** ===== Utils ===== */
// function sleep(ms: number) {
//     return new Promise((res) => setTimeout(res, ms));
// }

// function softTrim(s: string | null | undefined, max = 140) {
//     const t = (s || "").trim();
//     if (!t) return "";
//     return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
// }
// function approxTokens(str: string) {
//     return Math.ceil((str || "").length / 4);
// }
// function clampConcise(text: string, maxLines = IA_MAX_LINES): string {
//     let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
//     const lines = t ? t.split("\n").filter(Boolean) : [];
//     if (lines.length > maxLines) {
//         t = lines.slice(0, maxLines).join("\n").trim();
//         if (!/[.!?…]$/.test(t)) t += "…";
//     }
//     return t;
// }
// function formatConcise(
//     text: string,
//     maxLines = IA_MAX_LINES,
//     _maxChars = IA_MAX_CHARS,
//     allowEmoji = IA_ALLOW_EMOJI
// ): string {
//     let t = String(text || "").trim();
//     if (!t) return "Gracias por escribirnos. ¿Cómo puedo ayudarte?";
//     t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
//     t = clampConcise(t, maxLines);
//     if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
//         const EMOJIS = ["🙂", "💡", "👌", "✅", "✨", "🧴", "💬", "🫶"];
//         t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`;
//         t = clampConcise(t, maxLines);
//     }
//     return t;
// }
// function endsWithPunctuation(t: string) {
//     return /[.!?…]\s*$/.test((t || "").trim());
// }
// function closeNicely(raw: string): string {
//     let t = (raw || "").trim();
//     if (!t) return t;
//     if (endsWithPunctuation(t)) return t;
//     t = t.replace(/\s+[^\s]*$/, "").trim();
//     if (!t) return raw.trim();
//     return `${t}…`;
// }

// /** Moneda: COP */
// function formatCOP(value?: number | null): string | null {
//     if (value == null || isNaN(Number(value))) return null;
//     return new Intl.NumberFormat("es-CO", {
//         style: "currency",
//         currency: "COP",
//         maximumFractionDigits: 0,
//     }).format(Number(value));
// }

// /** ===== Detección de referencia explícita a imagen ===== */
// function mentionsImageExplicitly(t: string) {
//     const s = String(t || "").toLowerCase();
//     return (
//         /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
//         /(mira|revisa|checa|ve|verifica)\s+la\s+(foto|imagen)/.test(s) ||
//         /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
//         /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
//     );
// }

// /** ===== Selección de imagen contextual ===== */
// async function pickImageForContext(opts: {
//     conversationId: number;
//     directUrl?: string | null;
//     userText: string;
//     caption: string;
//     referenceTs: Date; // timestamp del último texto del cliente
// }): Promise<{ url: string | null; noteToAppend: string }> {
//     const { conversationId, directUrl, userText, caption, referenceTs } = opts;

//     if (directUrl) {
//         return {
//             url: String(directUrl),
//             noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "",
//         };
//     }
//     if (!userText) return { url: null, noteToAppend: "" };

//     // 1) Ventana corta automática
//     const veryRecent = await prisma.message.findFirst({
//         where: {
//             conversationId,
//             from: MessageFrom.client,
//             mediaType: MediaType.image,
//             timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
//         },
//         orderBy: { timestamp: "desc" },
//         select: { mediaUrl: true, caption: true },
//     });
//     if (veryRecent?.mediaUrl) {
//         const note = veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "";
//         return { url: String(veryRecent.mediaUrl), noteToAppend: note };
//     }

//     // 2) Mención explícita → lookback largo
//     if (mentionsImageExplicitly(userText)) {
//         const referenced = await prisma.message.findFirst({
//             where: {
//                 conversationId,
//                 from: MessageFrom.client,
//                 mediaType: MediaType.image,
//                 timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
//             },
//             orderBy: { timestamp: "desc" },
//             select: { mediaUrl: true, caption: true },
//         });
//         if (referenced?.mediaUrl) {
//             const note = referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "";
//             return { url: String(referenced.mediaUrl), noteToAppend: note };
//         }
//     }
//     return { url: null, noteToAppend: "" };
// }

// /** ====== Normalizador & Matchers semánticos ====== */
// function norm(s: string) {
//     return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// }

// function isCatalogQuery(t: string) {
//     const s = ` ${norm(t)} `;
//     const nouns = [
//         "servicio",
//         "servicios",
//         "procedimiento",
//         "procedimientos",
//         "tratamiento",
//         "tratamientos",
//         "catalogo",
//         "catálogo",
//         "catalog",
//     ];
//     const intents = ["que ", "qué ", "cuales", "cuáles", "lista", "disponible", "disponibles", "ofreces", "ofrecen", "tienes", "hay", "oferta"];
//     const hitNoun = nouns.some((k) => s.includes(` ${k} `));
//     const hitIntent = intents.some((k) => s.includes(k));
//     return hitNoun && hitIntent;
// }

// /** ===== Intents mínimos (texto) ===== */
// function detectIntent(
//     text: string
// ): "saludo" | "faq" | "agendar" | "reagendar" | "cancelar" | "confirmar" | "smalltalk" | "recomendar" {
//     const t = text.toLowerCase();
//     if (/(confirmo|confirmar|sí,?\s*correcto|si,?\s*correcto|correcto|dale|listo|agéndala|agendala)/i.test(t)) return "confirmar";
//     if (/(reagendar|cambiar|mover|otra hora|reprogramar)/i.test(t)) return "reagendar";
//     if (/(cancelar|anular)/i.test(t)) return "cancelar";
//     if (/(cita|agendar|agenda|programar|reservar)/i.test(t)) return "agendar";
//     if (isRecoAsk(text)) return "recomendar";
//     if (/(horario|direccion|dónde|servicios|procedimientos|tratamientos|cat[aá]logo|precios|costo|valor)/i.test(t)) return "faq";
//     if (/(hola|buen[oa]s|qué tal|como estas|saludo)/i.test(t)) return "saludo";
//     if (isCatalogQuery(text)) return "faq";
//     return "smalltalk";
// }

// /** ==== Pregunta de precio ==== */
// function asksPrice(t: string) {
//     const s = (t || "").toLowerCase();
//     return (
//         /\b(precio|costo|valor|tarifa)\b/i.test(s) ||
//         /\bcu[aá]nto\s+(vale|sale)\b/i.test(s) ||
//         /\b(que|qué)\s+vale\b/i.test(s)
//     );
// }

// /** ==== Follow-up de precio (“¿y el peeling?”) ==== */
// type LastIntentTag = "price" | "schedule";
// type DraftStage = "oferta" | "confirm" | "reagendar_pedir" | "reagendar_confirm" | "cancel_confirm";
// type Draft = {
//     empresaId: number;
//     serviceId?: number;
//     serviceName?: string;
//     duration?: number;
//     whenUTC?: string; // ISO
//     name?: string;
//     phone?: string;
//     stage?: DraftStage;
//     targetApptId?: number;

//     // Memoria de intención y cooldown
//     lastIntent?: LastIntentTag;
//     lastIntentAt?: number; // Date.now()
//     lastOfferAt?: number; // Date.now() cuando enviamos slots
// };

// function isFollowupPriceAsk(text: string, d?: Draft) {
//     const s = (text || "").toLowerCase().trim();
//     const looksLikeFollow =
//         /^y\s+(el|la|los|las)\b/.test(s) ||
//         /\b(peeling|botox|toxina|limpieza|facial|depilaci[oó]n|laser)\b/.test(s);
//     const recent = d?.lastIntent === "price" && Date.now() - (d.lastIntentAt || 0) < 15 * 60_000;
//     return looksLikeFollow && !!recent;
// }

// /** ==== Q&A clínica ==== */
// function isServiceInfoQuestion(t: string) {
//     const s = (t || "").toLowerCase();
//     return (
//         /\b(beneficios?|ventajas?|resultados?)\b/.test(s) ||
//         /\b(preparaci[oó]n|indicaciones|antes de|previo|ayuno|suspender)\b/.test(s) ||
//         /\b(contraindicaciones?|riesgos?|efectos?\s+secundarios?)\b/.test(s) ||
//         /\b(cuidados?|post\s*cuidado|post\s*operatorio|despu[eé]s de)\b/.test(s)
//     );
// }

// /** ==== “Evaluación/consulta gratuita” ==== */
// function asksFreeEval(t: string) {
//     const s = (t || "").toLowerCase();
//     return /\b(evaluaci[oó]n|valoraci[oó]n|consulta)\s+gratuit[ao]s?\b/.test(s) || /\bvaloraci[oó]n\s+sin\s+costo\b/.test(s);
// }

// /** ===== Extractores ===== */
// function extractPhone(text: string): string | undefined {
//     const clean = text.replace(/[^\d+]/g, " ");
//     const m = /(\+?57)?\s*(\d{10})\b/.exec(clean);
//     return m ? m[2] : undefined;
// }
// function extractName(text: string): string | undefined {
//     const m = /(soy|me llamo)\s+([a-záéíóúñ\s]{2,40})/i.exec(text);
//     if (m) return m[2].trim().replace(/\s+/g, " ").replace(/^\p{L}/u, (c: string) => c.toUpperCase());
//     return undefined;
// }
// function extractTime(text: string): string | undefined {
//     const m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
//     return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
// }

// /** ===== Util: duración segura del servicio ===== */
// function readSvcDuration(svc: any, kbRules?: any): number | undefined {
//     if (!svc) return undefined;
//     return svc.duration ?? svc.durationMin ?? kbRules?.defaultServiceDurationMin;
// }

// /** ===== Estado temporal (borrador) ===== */
// async function getDraft(chatId: number): Promise<Draft | undefined> {
//     const last = await prisma.message.findFirst({
//         where: {
//             conversationId: chatId,
//             from: MessageFrom.bot,
//             contenido: { startsWith: "[DEBUG booking]" },
//         },
//         orderBy: { id: "desc" },
//         select: { contenido: true },
//     });
//     if (!last) return;
//     try {
//         return JSON.parse(last.contenido.replace("[DEBUG booking] ", "")) as Draft;
//     } catch {
//         return;
//     }
// }
// async function putDraft(chatId: number, d: Draft) {
//     if (process.env.DEBUG_AI === "1") {
//         console.debug("[EST][DRAFT]", { chatId, ...d });
//     }
//     if (process.env.IA_DEBUG_DRAFT_TO_CHAT === "1") {
//         await prisma.message.create({
//             data: {
//                 empresaId: d.empresaId,
//                 conversationId: chatId,
//                 from: MessageFrom.bot,
//                 contenido: `[DEBUG booking] ${JSON.stringify(d)}`,
//             } as any,
//         });
//     }
// }

// /** ===== Historial compacto ===== */
// async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 10) {
//     const where: Prisma.MessageWhereInput = { conversationId };
//     if (excludeMessageId) where.id = { not: excludeMessageId };
//     const rows = await prisma.message.findMany({
//         where,
//         orderBy: { timestamp: "desc" },
//         take,
//         select: { from: true, contenido: true },
//     });
//     return rows.reverse().map((r) => ({
//         role: r.from === MessageFrom.client ? "user" : "assistant",
//         content: softTrim(r.contenido || "", 220),
//     }));
// }

// /** ===== Persistencia y envío ===== */
// function normalizeToE164(n: string) {
//     return String(n || "").replace(/[^\d]/g, "");
// }
// async function persistBotReply({
//     conversationId,
//     empresaId,
//     texto,
//     nuevoEstado,
//     to,
//     phoneNumberId,
// }: {
//     conversationId: number;
//     empresaId: number;
//     texto: string;
//     nuevoEstado: ConversationEstado;
//     to?: string;
//     phoneNumberId?: string;
// }) {
//     const msg = await prisma.message.create({
//         data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
//     });
//     await prisma.conversation.update({
//         where: { id: conversationId },
//         data: { estado: nuevoEstado },
//     });

//     let wamid: string | undefined;
//     if (to && String(to).trim()) {
//         try {
//             const resp = await Wam.sendWhatsappMessage({
//                 empresaId,
//                 to: normalizeToE164(to),
//                 body: texto,
//                 phoneNumberIdHint: phoneNumberId,
//             });
//             wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
//             if (wamid)
//                 await prisma.message.update({
//                     where: { id: msg.id },
//                     data: { externalId: wamid },
//                 });
//         } catch {
//             /* noop */
//         }
//     }
//     return { messageId: msg.id, texto, wamid };
// }

// /** ===== Prompt budgeting ===== */
// function budgetMessages(messages: any[], budgetPromptTokens = 110) {
//     const sys = messages.find((m: any) => m.role === "system");
//     const user = messages.find((m: any) => m.role === "user");
//     if (!sys) return messages;

//     const sysText = String(sys.content || "");
//     const userText =
//         typeof user?.content === "string"
//             ? user?.content
//             : Array.isArray(user?.content)
//                 ? String(user?.content?.[0]?.text || "")
//                 : "";

//     let total = approxTokens(sysText) + approxTokens(userText);
//     for (const m of messages) {
//         if (m.role !== "system" && m !== user) {
//             const t =
//                 typeof m.content === "string"
//                     ? m.content
//                     : Array.isArray(m.content)
//                         ? String(m.content?.[0]?.text || "")
//                         : "";
//             total += approxTokens(t);
//         }
//     }
//     if (total <= budgetPromptTokens) return messages;

//     const lines = sysText.split("\n").map((l: string) => l.trim()).filter(Boolean);
//     const keep: string[] = [];
//     for (const l of lines) {
//         if (/Agente de clínica estética|Escritura: humana|Mantén el foco|Para \*agendar\*|Si mencionan|Menciona precios/i.test(l))
//             keep.push(l);
//         if (keep.length >= 7) break;
//     }
//     (sys as any).content = keep.join("\n") || lines.slice(0, 7).join("\n");

//     if (typeof user?.content === "string") {
//         const ut = String(user.content);
//         user.content = ut.length > 240 ? ut.slice(0, 240) : ut;
//     } else if (Array.isArray(user?.content)) {
//         const ut = String(user.content?.[0]?.text || "");
//         user.content[0].text = softTrim(ut, 240);
//     }
//     return messages;
// }

// /** ===== Core LLM ===== */
// async function runChatWithBudget({
//     model,
//     messages,
//     temperature,
//     maxTokens,
// }: {
//     model: string;
//     messages: any[];
//     temperature: number;
//     maxTokens: number;
// }) {
//     try {
//         const resp = await (openai.chat.completions.create as any)({
//             model,
//             messages,
//             temperature,
//             max_tokens: maxTokens,
//         });
//         return resp?.choices?.[0]?.message?.content?.trim() || "";
//     } catch {
//         const resp2 = await (openai.chat.completions.create as any)({
//             model,
//             messages,
//             temperature,
//             max_tokens: 48,
//         });
//         return resp2?.choices?.[0]?.message?.content?.trim() || "";
//     }
// }

// /** ====== Helpers de citas (offset 5h en APPOINTMENT) ====== */
// const APPT_DB_OFFSET_MIN = 300; // 5 horas
// const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60000);
// const applyApptOffsetWrite = (utc: Date) => addMinutes(utc, -APPT_DB_OFFSET_MIN);
// const applyApptOffsetRead = (dbUtcWithOffset: Date) => addMinutes(dbUtcWithOffset, APPT_DB_OFFSET_MIN);

// async function getUpcomingAppointmentForConversation(empresaId: number, conversationId: number) {
//     const nowUTC = new Date();
//     const nowDB = applyApptOffsetWrite(nowUTC);
//     const appt = await prisma.appointment.findFirst({
//         where: {
//             empresaId,
//             conversationId,
//             status: {
//                 in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled],
//             },
//             startAt: { gte: nowDB },
//             deletedAt: null,
//         },
//         orderBy: { startAt: "asc" },
//         select: {
//             id: true,
//             serviceName: true,
//             startAt: true,
//             endAt: true,
//             timezone: true,
//             customerName: true,
//             customerPhone: true,
//             serviceDurationMin: true,
//         },
//     });
//     if (!appt) return null;
//     return {
//         ...appt,
//         startAt: applyApptOffsetRead(appt.startAt),
//         endAt: applyApptOffsetRead(appt.endAt),
//     };
// }

// /** ===== Helpers: lista de servicios habilitados ===== */
// function listEnabledServices(kb: any, max = 12): string {
//     const names = (kb?.services ?? [])
//         .filter((s: any) => s && s.enabled !== false)
//         .map((s: any) => s.name);
//     return names.slice(0, max).join(", ");
// }

// /** ====== Clasificador LLM de intención (backup) ====== */
// async function classifyIntentLLM(
//     text: string
// ): Promise<"catalog" | "price" | "schedule" | "reschedule" | "cancel" | "other"> {
//     const sys =
//         "Clasifica el mensaje del usuario en una sola etiqueta: catalog|price|schedule|reschedule|cancel|other. SOLO responde la etiqueta.";
//     try {
//         const resp = await (openai.chat.completions.create as any)({
//             model: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
//             temperature: 0,
//             max_tokens: 3,
//             messages: [{ role: "system", content: sys }, { role: "user", content: String(text || "").slice(0, 200) }],
//         });
//         const tag = resp?.choices?.[0]?.message?.content?.trim()?.toLowerCase() || "other";
//         if (["catalog", "price", "schedule", "reschedule", "cancel", "other"].includes(tag)) return tag as any;
//         return "other";
//     } catch {
//         return "other";
//     }
// }

// /** —— Saludo humano y variable —— */
// const GREET_VARIANTS = [
//     (n?: string) => (n ? `¡Hola ${n}! ¿En qué te ayudo hoy?` : `¡Hola! ¿En qué te ayudo hoy?`),
//     (n?: string) => (n ? `Hola ${n}, cuéntame qué tienes en mente.` : `Hola, cuéntame qué tienes en mente.`),
//     (n?: string) => (n ? `Qué gusto leerte, ${n}. Dime qué buscas y te guío.` : `Qué gusto leerte. Dime qué buscas y te guío.`),
// ];
// function humanGreet(name?: string) {
//     const pick = GREET_VARIANTS[Math.floor(Math.random() * GREET_VARIANTS.length)];
//     return pick(name?.trim() || undefined);
// }

// /** —— Bolsita: pedir faltantes de forma natural —— */
// function askMissingFields(d: Draft) {
//     const missing: string[] = [];
//     if (!d.serviceId) missing.push("el *procedimiento* que te interesa");
//     if (!d.whenUTC) missing.push("la *fecha y hora* que prefieres");
//     if (!d.name) missing.push("tu *nombre*");
//     if (!d.phone) missing.push("tu *teléfono*");

//     if (!missing.length) return null;

//     if (missing.length === 1) return `Perfecto. Solo me falta ${missing[0]} para reservar.`;
//     if (missing.length === 2) return `Genial. Me faltan ${missing[0]} y ${missing[1]} para dejarte la reserva lista.`;
//     return `Te voy ayudando: dime ${missing.slice(0, -1).join(", ")} y ${missing.slice(-1)[0]} para reservar.`;
// }

// /** —— Intención “recomendar” —— */
// function isRecoAsk(t: string) {
//     const s = (t || "").toLowerCase();
//     return /\b(recomiend(a|as|e)|qué me recomiendas|no sé qué hacer|que me sirve|qué me puede(n)? servir|cuál conviene)\b/.test(s);
// }

// /** —— Recomendador simple desde KB —— */
// type RecoInput = { text: string; kb: any };
// function recommendServices({ text, kb }: RecoInput) {
//     const s = norm(text);
//     const goals = [
//         { key: /acne|acn[eé]|espinilla|grano/, tag: /limpieza|facial|peeling|acn/i },
//         { key: /mancha|melasma|hiperpig/, tag: /peeling|facial|mancha|laser/i },
//         { key: /arruga|linea|línea|flacidez|antiage|anti-edad/, tag: /toxina|botul|relleno|hilo|radio/i },
//         { key: /vello|depilacion|depilación/, tag: /depilaci|laser/i },
//         { key: /poros|textura|brillo/, tag: /limpieza|peeling|facial/i },
//     ];
//     const enabled = (kb?.services ?? []).filter((x: any) => x && x.enabled !== false);
//     const hits: any[] = [];

//     for (const g of goals) {
//         if (g.key.test(s)) {
//             for (const svc of enabled) {
//                 const name = String(svc.name || "");
//                 const al = (svc.aliases || []).join(" ");
//                 if (g.tag.test(name) || g.tag.test(al)) hits.push(svc);
//             }
//         }
//     }
//     const base = hits.length ? hits : enabled;
//     const unique = Array.from(new Map(base.map((x: any) => [x.id, x])).values());
//     return unique.slice(0, 3);
// }

// /** ======= PUBLIC: handleEsteticaReply ======= */
// export async function handleEsteticaReply(args: {
//     chatId: number;
//     empresaId: number;
//     mensajeArg?: string;
//     toPhone?: string;
//     phoneNumberId?: string;
//     apptConfig?: {
//         timezone: string;
//         bufferMin: number;
//         vertical: AppointmentVertical | "custom";
//         verticalCustom: string | null;
//         enabled: boolean;
//         policies: string | null;
//         reminders: boolean;
//         services?: string[];
//         servicesText?: string;
//         logistics?: {
//             locationName?: string;
//             locationAddress?: string;
//             locationMapsUrl?: string;
//             virtualMeetingLink?: string;
//             parkingInfo?: string;
//             instructionsArrival?: string;
//         };
//         rules?: Record<string, any>;
//         remindersConfig?: Record<string, any>;
//         kb?: Record<string, any>;
//     };
// }): Promise<IAReplyResult> {
//     const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = args;

//     // 1) Conversación y último inbound del cliente
//     const conversacion = await prisma.conversation.findUnique({
//         where: { id: chatId },
//         select: { id: true, estado: true, phone: true },
//     });
//     if (!conversacion) return { estado: ConversationEstado.pendiente, mensaje: "" };

//     const last = await prisma.message.findFirst({
//         where: { conversationId: chatId, from: MessageFrom.client },
//         orderBy: { timestamp: "desc" },
//         select: {
//             id: true,
//             mediaType: true,
//             mediaUrl: true,
//             caption: true,
//             isVoiceNote: true,
//             transcription: true,
//             contenido: true,
//             mimeType: true,
//             timestamp: true,
//         },
//     });

//     // 🔒 Idempotencia inbound
//     if (last?.id && seenInboundRecently(last.id)) {
//         if (process.env.DEBUG_AI === "1") console.log("[EST] Skip: inbound already processed", { lastId: last.id });
//         return { estado: conversacion.estado, mensaje: "" };
//     }

//     // 2) KB
//     const kb = await loadEsteticaKB(empresaId);
//     if (!kb) {
//         return {
//             estado: ConversationEstado.requiere_agente,
//             mensaje: "Ahora mismo no tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
//         };
//     }

//     // 3) Texto del usuario (nota de voz → transcripción si aplica)
//     let userText = (mensajeArg || "").trim();
//     if (!userText && last?.isVoiceNote) {
//         let transcript = (last.transcription || "").trim();
//         if (!transcript) {
//             try {
//                 let audioBuf: Buffer | null = null;
//                 if (last.mediaUrl && /^https?:\/\//i.test(String(last.mediaUrl))) {
//                     const { data } = await axios.get(String(last.mediaUrl), {
//                         responseType: "arraybuffer",
//                         timeout: 30000,
//                     });
//                     audioBuf = Buffer.from(data);
//                 }
//                 if (audioBuf) {
//                     const name = last.mimeType?.includes("mpeg")
//                         ? "audio.mp3"
//                         : last.mimeType?.includes("wav")
//                             ? "audio.wav"
//                             : last.mimeType?.includes("m4a")
//                                 ? "audio.m4a"
//                                 : last.mimeType?.includes("webm")
//                                     ? "audio.webm"
//                                     : "audio.ogg";
//                     transcript = await transcribeAudioBuffer(audioBuf, name);
//                     if (transcript)
//                         await prisma.message.update({
//                             where: { id: last.id },
//                             data: { transcription: transcript },
//                         });
//                 }
//             } catch (e) {
//                 if (process.env.DEBUG_AI === "1") console.error("[EST] Transcription error:", (e as any)?.message || e);
//             }
//         }
//         if (transcript) userText = transcript;
//     }

//     const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
//     const imageUrl = isImage ? String(last?.mediaUrl) : null;
//     const caption = String(last?.caption || "").trim();
//     const referenceTs = last?.timestamp ?? new Date();

//     // Debounce por conversación
//     if (isImage) {
//         if (!caption && !userText) {
//             if (process.env.DEBUG_AI === "1") console.log("[EST] Image-only: defer to upcoming text");
//             await sleep(IMAGE_WAIT_MS);
//             return { estado: conversacion.estado, mensaje: "" };
//         }
//     }

//     // 4) INTENT + flujo de agenda (draft/confirmaciones)
//     let intent = detectIntent(userText || caption || "");
//     if (intent === "smalltalk") {
//         const tag = await classifyIntentLLM(userText || caption || "");
//         if (tag === "catalog") intent = "faq";
//         else if (tag === "price") intent = "faq";
//         else if (tag === "schedule") intent = "agendar";
//         else if (tag === "reschedule") intent = "reagendar";
//         else if (tag === "cancel") intent = "cancelar";
//     }

//     const draft = (await getDraft(chatId)) ?? ({ empresaId } as Draft);

//     // Resolver servicio por texto o mantener el previo (solo para agendar)
//     let svc =
//         resolveServiceName(kb, userText) ??
//         (draft.serviceId ? kb.services.find((s: any) => s.id === draft.serviceId) ?? null : null);

//     // Guard: si el match fue flojo, mantén el anterior
//     if (!svc && draft.serviceId) {
//         svc = kb.services.find((s: any) => s.id === draft.serviceId) ?? null;
//     }

//     if (svc && (!draft.serviceId || draft.serviceId !== svc.id)) {
//         draft.serviceId = svc.id;
//         draft.serviceName = svc.name;
//         draft.duration = readSvcDuration(svc, (kb as any)?.rules) ?? 60;
//     }

//     // Fecha relativa + hora (si vienen)
//     const rel = parseRelativeDateText(userText, kb.timezone);
//     const hhmm = extractTime(userText);
//     if (rel.ok && hhmm) {
//         draft.whenUTC = combineLocalDateTime(rel.localStart, hhmm, kb.timezone).toISOString();
//     }

//     // Nombre / Teléfono
//     const name = extractName(userText);
//     const phone = extractPhone(userText);
//     if (name) draft.name = name;
//     if (phone) draft.phone = phone;

//     /** ==== Ajuste: si preguntan por horarios y hay servicio en contexto → agendar ==== */
//     const askedForSlots = /\b(horario|horarios|disponibilidad|cupos?)\b/i.test(userText);
//     if (intent === "faq" && askedForSlots && (svc || draft.serviceId)) {
//         intent = "agendar";
//     }

//     /** ==== No ofrecemos evaluación/consulta gratuita ==== */
//     if (asksFreeEval(userText || caption || "")) {
//         const svcCtx =
//             (draft.serviceId && kb.services.find((s: any) => s.id === draft.serviceId)) ||
//             resolveServiceName(kb, userText || "") ||
//             null;

//         const base =
//             "Por ahora no manejamos evaluaciones gratuitas. Puedo orientarte por aquí y agendar directamente el procedimiento que te interese.";
//         let extra = "";
//         if (svcCtx) {
//             const desde = serviceDisplayPrice(svcCtx);
//             if (desde) extra = ` Para *${svcCtx.name}* el valor es *desde ${desde}*.`;
//         }
//         const tail = " ¿Te comparto horarios o prefieres primero ver precios y duración de un servicio?";
//         const txt = `${base}${extra}${tail}`;

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: txt,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     /** ==== Q&A dentro de OFERTA: si pregunta info clínica, responde sin repetir slots ==== */
//     if (draft.stage === "oferta" && (isServiceInfoQuestion(userText) || intent === "faq")) {
//         const svcCtx =
//             (draft.serviceId && kb.services.find((s: any) => s.id === draft.serviceId)) || svc || null;

//         let info = "";
//         if ((svcCtx as any)?.prepInstructions) info += `**Indicaciones previas:** ${(svcCtx as any).prepInstructions}\n`;
//         if ((svcCtx as any)?.postCare) info += `**Cuidados posteriores:** ${(svcCtx as any).postCare}\n`;
//         if ((svcCtx as any)?.contraindications)
//             info += `**Contraindicaciones:** ${(svcCtx as any).contraindications}\n`;

//         if (!info) {
//             info =
//                 "Orientación general: evita exfoliantes fuertes 48–72h antes, llega con piel limpia el día de la cita y usa bloqueador. Si tomas medicación o tienes condiciones de piel, avísanos previamente.";
//         }

//         const txt = `Sobre *${svcCtx?.name || "el procedimiento"}*:\n${info.trim()}\n\n¿Retomamos opciones de horario o tienes otra duda?`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: txt,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     /** ==== Preguntas de precio de un servicio específico (con follow-up) ==== */
//     if ((asksPrice(userText) || isFollowupPriceAsk(userText, draft)) && svc) {
//         const pLabel = serviceDisplayPrice(svc); // “Desde $X”
//         const dep = formatCOP((svc as any).deposit ?? null);
//         const note = (svc as any).priceNote as string | null | undefined;
//         const dur = readSvcDuration(svc, (kb as any)?.rules);

//         const priceLine = pLabel
//             ? `tiene un valor *desde ${pLabel}*.`
//             : `no tiene un precio registrado en el sistema.`;
//         const depLine = dep ? ` Requerimos un anticipo de ${dep} para reservar.` : "";
//         const noteLine = note ? ` ${note}` : "";
//         const durLine = dur ? ` La sesión dura aproximadamente *${dur} min*.` : "";

//         const cuerpo = `El tratamiento de *${svc.name}* ${priceLine}${durLine}${depLine}${noteLine} ¿Te paso opciones de horario?`;

//         // Memorizar intención
//         draft.lastIntent = "price";
//         draft.lastIntentAt = Date.now();
//         await putDraft(chatId, draft);

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: cuerpo,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     /** ====== RECOMENDAR ====== */
//     if (intent === "recomendar") {
//         const picks = recommendServices({ text: userText, kb });
//         if (!picks.length) {
//             const txt = "Puedo orientarte según lo que quieres mejorar (manchas, acné, líneas finas, depilación láser, etc.). ¿Qué objetivo tienes?";
//             const saved = await persistBotReply({
//                 conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone, phoneNumberId
//             });
//             return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         }
//         const names = picks.map((p: any) => p.name).join(", ");
//         const tail = askMissingFields(draft) ?? "¿Te comparto horarios para alguno?";
//         const txt = `Por lo que me cuentas, te podrían servir: ${names}. ${tail}`;
//         const saved = await persistBotReply({
//             conversationId: chatId, empresaId, texto: txt, nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone, phoneNumberId
//         });
//         return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     /** ====== AGENDAR ====== */
//     if (intent === "agendar") {
//         // Bolsita: si faltan datos clave, pídelos humano
//         const need = askMissingFields(draft);
//         if (need && !(draft.serviceId && draft.whenUTC && draft.name && draft.phone)) {
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: need,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         }

//         if (draft.serviceId && draft.whenUTC && draft.name && draft.phone && draft.stage !== "confirm") {
//             draft.stage = "confirm";
//             await putDraft(chatId, draft);
//             const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
//             const fecha = local.toLocaleDateString("es-CO", {
//                 weekday: "long",
//                 year: "numeric",
//                 month: "long",
//                 day: "2-digit",
//             });
//             const hora = local.toLocaleTimeString("es-CO", {
//                 hour: "2-digit",
//                 minute: "2-digit",
//                 hour12: false,
//             });
//             const resumen =
//                 `Voy a reservar tu cita, ¿me confirmas por favor?\n` +
//                 `• Servicio: ${draft.serviceName}\n` +
//                 `• Fecha/Hora: ${fecha} a las ${hora}\n` +
//                 `• Nombre: ${draft.name}\n` +
//                 `• Teléfono: ${draft.phone}\n\n` +
//                 `Si está correcto, dime *"confirmo"* y la agendo ✅`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: resumen,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }

//         if (!svc) {
//             const hint = `Perfecto. Trabajo con los servicios habilitados de la clínica. ¿Cuál te interesa? (Ej.: ${kb.services
//                 .slice(0, 3)
//                 .map((s: any) => s.name)
//                 .join(", ")})`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: hint,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }

//         const duration = draft.duration ?? readSvcDuration(svc, (kb as any)?.rules) ?? 60;

//         const nowLocal = new Date();
//         const anchorLocal = rel.ok ? rel.localStart : nowLocal;
//         const anchorUTC = fromLocalTZToUTC(anchorLocal, kb.timezone);

//         const slots: SlotView[] = await findNextSlots({
//             empresaId,
//             timezone: kb.timezone,
//             serviceDurationMin: duration,
//             fromDateUTC: anchorUTC,
//             days: 14,
//             bufferMin: kb.bufferMin ?? 10,
//         });

//         if (!slots.length) {
//             const txt = `Puedo ayudarte con *${svc.name}*, pero no veo horarios disponibles en los próximos días. ¿Te contacto con un asesor para coordinar?`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: txt,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }

//         // Cooldown anti-loop de slots
//         if (draft.lastOfferAt && Date.now() - draft.lastOfferAt < 90_000) {
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto:
//                     `¿Te sirve alguna de las opciones que te envié recién? ` +
//                     `Si prefieres otra fecha/hora, dímela (ej. "viernes 10:30").`,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }

//         draft.serviceId = svc.id;
//         draft.serviceName = svc.name;
//         draft.duration = duration;
//         draft.stage = "oferta";
//         draft.lastIntent = "schedule";
//         draft.lastIntentAt = Date.now();
//         draft.lastOfferAt = Date.now();
//         await putDraft(chatId, draft);

//         const primeros = slots.slice(0, 5).map((s) => `• ${s.label}`).join("\n");
//         const prompt =
//             `Para *${svc.name}* tengo estas opciones próximas:\n${primeros}\n\n` +
//             `¿Te funciona alguna? Si ya tienes fecha/hora exacta, dímela (ej. “mañana 10:30”). También necesito tu *nombre* y *teléfono* para reservar.`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: prompt,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     if (intent === "confirmar" && draft.stage === "confirm" && draft.serviceId && draft.whenUTC && draft.name && draft.phone) {
//         try {
//             await bookAppointment({
//                 empresaId,
//                 conversationId: chatId,
//                 customerName: draft.name!,
//                 customerPhone: draft.phone!,
//                 serviceName: draft.serviceName!,
//                 serviceDurationMin: draft.duration ?? 60,
//                 timezone: kb.timezone,
//                 startAtUTC: new Date(draft.whenUTC),
//                 source: "ai",
//             });
//             const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
//             const fecha = local.toLocaleDateString("es-CO", {
//                 weekday: "long",
//                 year: "numeric",
//                 month: "long",
//                 day: "2-digit",
//             });
//             const hora = local.toLocaleTimeString("es-CO", {
//                 hour: "2-digit",
//                 minute: "2-digit",
//                 hour12: false,
//             });

//             const ok = `¡Listo! Tu cita de *${draft.serviceName}* quedó para **${fecha} a las ${hora}** a nombre de *${draft.name}*. 📅`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: ok,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         } catch (e: any) {
//             const fail = `Ese horario acaba de ocuparse. ¿Te paso 5 opciones cercanas para *${draft.serviceName}*?`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: fail,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }
//     }

//     /** ====== REAGENDAR ====== */
//     if (intent === "reagendar") {
//         const appt = await getUpcomingAppointmentForConversation(empresaId, chatId);
//         if (!appt) {
//             const txt =
//                 `No encuentro una cita futura asociada a esta conversación. ` +
//                 `¿Podrías indicarme el *nombre completo* con el que quedó la reserva o el *teléfono*?`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: txt,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }

//         draft.targetApptId = appt.id;
//         draft.stage = "reagendar_pedir";
//         await putDraft(chatId, draft);

//         const local = fromUTCtoLocalTZ(appt.startAt, appt.timezone || kb.timezone);
//         const fecha = local.toLocaleDateString("es-CO", {
//             weekday: "long",
//             year: "numeric",
//             month: "long",
//             day: "2-digit",
//         });
//         const hora = local.toLocaleTimeString("es-CO", {
//             hour: "2-digit",
//             minute: "2-digit",
//             hour12: false,
//         });
//         const ask = `Tienes *${appt.serviceName}* para **${fecha} a las ${hora}**. Dime la *nueva fecha y hora* (ej. “mañana 10:30”) y te paso la confirmación.`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: ask,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     // Reagendar: confirmación
//     if (draft.stage === "reagendar_pedir" && draft.targetApptId) {
//         if (rel.ok && hhmm) {
//             draft.whenUTC = combineLocalDateTime(rel.localStart, hhmm, kb.timezone).toISOString();
//             draft.stage = "reagendar_confirm";
//             await putDraft(chatId, draft);

//             const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
//             const fecha = local.toLocaleDateString("es-CO", {
//                 weekday: "long",
//                 year: "numeric",
//                 month: "long",
//                 day: "2-digit",
//             });
//             const hora = local.toLocaleTimeString("es-CO", {
//                 hour: "2-digit",
//                 minute: "2-digit",
//                 hour12: false,
//             });
//             const resumen = `¿Confirmas mover tu cita a **${fecha} a las ${hora}**? Di *"confirmo"* y la reagendo ✅`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: resumen,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         } else {
//             const hint = `Entiendo, dime la *fecha y hora exacta* (ej. “pasado mañana 15:00”) para reagendar.`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: hint,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }
//     }

//     if (intent === "confirmar" && draft.stage === "reagendar_confirm" && draft.targetApptId && draft.whenUTC) {
//         try {
//             await rescheduleAppointment({
//                 empresaId,
//                 appointmentId: draft.targetApptId,
//                 newStartAtUTC: new Date(draft.whenUTC),
//             });

//             const local = fromUTCtoLocalTZ(new Date(draft.whenUTC), kb.timezone);
//             const fecha = local.toLocaleDateString("es-CO", {
//                 weekday: "long",
//                 year: "numeric",
//                 month: "long",
//                 day: "2-digit",
//             });
//             const hora = local.toLocaleTimeString("es-CO", {
//                 hour: "2-digit",
//                 minute: "2-digit",
//                 hour12: false,
//             });
//             const ok = `¡Hecho! Reagendé tu cita para **${fecha} a las ${hora}**.`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: ok,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         } catch (e: any) {
//             const fail = `Ese nuevo horario acaba de ocuparse. ¿Te comparto otras opciones cercanas?`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: fail,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }
//     }

//     /** ====== CANCELAR ====== */
//     if (intent === "cancelar") {
//         const appt = await getUpcomingAppointmentForConversation(empresaId, chatId);
//         if (!appt) {
//             const txt =
//                 `No encuentro una cita futura asociada a esta conversación. ` +
//                 `¿Podrías indicarme el *nombre completo* o el *teléfono* con el que quedó la reserva?`;
//             const saved = await persistBotReply({
//                 conversationId: chatId,
//                 empresaId,
//                 texto: txt,
//                 nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             return {
//                 estado: ConversationEstado.en_proceso,
//                 mensaje: saved.texto,
//                 messageId: saved.messageId,
//                 wamid: saved.wamid,
//                 media: [],
//             };
//         }
//         draft.targetApptId = appt.id;
//         draft.stage = "cancel_confirm";
//         await putDraft(chatId, draft);

//         const local = fromUTCtoLocalTZ(appt.startAt, appt.timezone || kb.timezone);
//         const fecha = local.toLocaleDateString("es-CO", {
//             weekday: "long",
//             year: "numeric",
//             month: "long",
//             day: "2-digit",
//         });
//         const hora = local.toLocaleTimeString("es-CO", {
//             hour: "2-digit",
//             minute: "2-digit",
//             hour12: false,
//         });
//         const ask = `Vas a cancelar *${appt.serviceName}* del **${fecha} a las ${hora}**. ¿Lo confirmas? Di *"confirmo"* y la cancelo.`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: ask,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     if (intent === "confirmar" && draft.stage === "cancel_confirm" && draft.targetApptId) {
//         await cancelAppointment(empresaId, draft.targetApptId, "Cancelación solicitada por el cliente (IA).");
//         const ok = `Tu cita fue cancelada ✅. Si deseas, puedo proponerte nuevos horarios.`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: ok,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     /** ==== FAQ catálogo ==== */
//     if (isCatalogQuery(userText || caption || "")) {
//         const serviciosTxt = listEnabledServices(kb);
//         const cuerpo = serviciosTxt
//             ? `Estos son nuestros servicios disponibles: ${serviciosTxt}.\n¿Te interesa agendar alguno en particular?`
//             : `Por ahora no tengo servicios configurados para agendar. Si quieres, te doy orientación general sobre tratamientos estéticos.`;
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: cuerpo,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return {
//             estado: ConversationEstado.en_proceso,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     /** ==== Saludo humano (solo si es inicio) ==== */
//     if (intent === "saludo" && !svc && !/servicio/i.test(userText)) {
//         const human = humanGreet(draft?.name);
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: human,
//             nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     /** ====== SALUDO / FAQ / GENERAL (LLM con imagen) ====== */
//     const baseIntro = kb.empresaNombre
//         ? `Agente de clínica estética de "${kb.empresaNombre}".`
//         : `Agente de clínica estética.`;
//     const system = [
//         baseIntro,
//         "Escritura: humana, cercana y profesional. Nada robótico. Respuestas breves (2–5 líneas) y específicas.",
//         "Habla en primera persona (yo). Evita presentarte como bot o asistente.",
//         "Mantén el foco en estética: orientación y agenda.",
//         "Para *agendar* o *listar* procedimientos usa *solo* los de la base de datos (kb.services).",
//         "Si mencionan un tratamiento fuera del catálogo: orienta y sugiere el equivalente del catálogo para agendar.",
//         "No ofrezcas evaluaciones/consultas gratuitas.",
//         "Menciona precios solo si te lo piden. Cuando lo hagas, usa *priceMin* con: “Desde $X (COP)”.",
//         kb.kbTexts.businessOverview ? `Contexto negocio: ${softTrim(kb.kbTexts.businessOverview, 220)}` : "",
//         kb.logistics?.locationAddress ? `Dirección: ${kb.logistics.locationAddress}` : "",
//         kb.logistics?.locationName ? `Sede: ${kb.logistics.locationName}` : "",
//         kb.logistics?.locationMapsUrl ? `Maps: ${kb.logistics.locationMapsUrl}` : "",
//         kb.kbTexts.disclaimers ? `Avisos: ${softTrim(kb.kbTexts.disclaimers, 220)}` : "",
//         "Si notas intención de agendar, guía a escoger servicio habilitado y ofrece horarios concretos.",
//         "Ejemplo tono:\nUsuario: ¿Qué me recomiendas para manchas?\nAgente: Para manchas suele funcionar muy bien un *peeling químico* o una *limpieza profunda* si buscas algo suave. Si quieres, te paso horarios. Si prefieres precio, te digo el “Desde $X”.",
//         "Ejemplo agenda:\nUsuario: Mañana 10:30 limpieza facial, me llamo Ana, 3001234567.\nAgente: Perfecto, Ana. Te confirmo: Limpieza facial, mañana 10:30. ¿Confirmas para agendar?",
//     ]
//         .filter(Boolean)
//         .join("\n");

//     const history = await getRecentHistory(chatId, last?.id, 10);

//     // Imagen contextual
//     let effectiveImageUrl = isImage ? imageUrl : null;
//     let textForLLM = (userText || caption || "Hola").trim();
//     if (!effectiveImageUrl && textForLLM) {
//         const picked = await pickImageForContext({
//             conversationId: chatId,
//             directUrl: null,
//             userText: textForLLM,
//             caption,
//             referenceTs,
//         });
//         effectiveImageUrl = picked.url;
//         if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
//     }

//     const messages: any[] = [{ role: "system", content: system }, ...history];
//     if (effectiveImageUrl) {
//         messages.push({
//             role: "user",
//             content: [
//                 { type: "text", text: textForLLM || "Hola" },
//                 { type: "image_url", image_url: { url: effectiveImageUrl } },
//             ],
//         });
//     } else {
//         messages.push({ role: "user", content: textForLLM || "Hola" });
//     }
//     budgetMessages(messages, Number(process.env.IA_PROMPT_BUDGET ?? 110));

//     const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
//     const temperature = Number(process.env.IA_TEMPERATURE ?? 0.5); // un poco más libre
//     const MAX_OUT = Math.min(IA_MAX_TOKENS, 180);

//     let texto = "";
//     try {
//         texto = await runChatWithBudget({
//             model,
//             messages,
//             temperature,
//             maxTokens: MAX_OUT,
//         });
//     } catch (err: any) {
//         console.error("[EST] OpenAI error (final):", err?.response?.data || err?.message || err);
//         texto = "Gracias por escribirme. Te oriento y si quieres agendamos.";
//     }
//     texto = closeNicely(texto);
//     texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI);

//     // Blindaje de montos: SOLO si no están preguntando por precio y el LLM inventó montos explícitos.
//     const asked = asksPrice(userText) || isFollowupPriceAsk(userText, draft);
//     if (!asked) {
//         const hasMoney = KB_MONEY_RE.test(texto);
//         if (hasMoney) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
//     }

//     // ⛔️ SIN DELAY
//     const saved = await persistBotReply({
//         conversationId: chatId,
//         empresaId,
//         texto,
//         nuevoEstado: ConversationEstado.respondido,
//         to: toPhone ?? conversacion.phone,
//         phoneNumberId,
//     });

//     return {
//         estado: ConversationEstado.respondido,
//         mensaje: saved.texto,
//         messageId: saved.messageId,
//         wamid: saved.wamid,
//         media: [],
//     };
// }




// utils/ai/strategies/estetica.strategy.ts

import axios from "axios";
import prisma from "../../../lib/prisma";
import { openai } from "../../../lib/openai";
import type { Prisma, AppointmentVertical } from "@prisma/client";
import { ConversationEstado, MediaType, MessageFrom } from "@prisma/client";

import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";

import {
    loadEsteticaKB,
    resolveServiceName,
    serviceDisplayPrice,
    MONEY_RE as KB_MONEY_RE,
    type EsteticaKB,
    formatCOP,
} from "./esteticaModules/domain/estetica.kb";

import {
    getNextAvailableSlots,
    createAppointmentSafe,
    type Slot,
} from "./esteticaModules/schedule/estetica.schedule";

// ================== Config ==================
const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 5 * 60 * 1000);

const IA_MAX_LINES = Number(process.env.IA_MAX_LINES ?? 5);
const IA_MAX_CHARS = Number(process.env.IA_MAX_CHARS ?? 1000);
const IA_MAX_TOKENS = Number(process.env.IA_MAX_TOKENS ?? 180);
const IA_ALLOW_EMOJI = (process.env.IA_ALLOW_EMOJI ?? "0") === "1";

// ================== Utils ==================
const processedInbound = new Map<number, number>(); // messageId -> ts
function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS): boolean {
    const now = Date.now();
    const prev = processedInbound.get(messageId);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(messageId, now);
    return false;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

function softTrim(s: string | null | undefined, max = 220) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function approxTokens(str: string) { return Math.ceil((str || "").length / 4); }
function clampConcise(text: string, maxLines = IA_MAX_LINES): string {
    let t = String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const lines = t ? t.split("\n").filter(Boolean) : [];
    if (lines.length > maxLines) {
        t = lines.slice(0, maxLines).join("\n").trim();
        if (!/[.!?…]$/.test(t)) t += "…";
    }
    return t;
}
function formatConcise(
    text: string,
    maxLines = IA_MAX_LINES,
    _maxChars = IA_MAX_CHARS,
    allowEmoji = IA_ALLOW_EMOJI
): string {
    let t = String(text || "").trim();
    if (!t) return "Gracias por escribirnos. ¿Cómo puedo ayudarte?";
    t = t.replace(/^[•\-]\s*/gm, "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    t = clampConcise(t, maxLines);
    if (allowEmoji && !/[^\w\s.,;:()¿?¡!…]/.test(t)) {
        const EMOJIS = ["🙂", "💡", "👌", "✅", "✨", "🧴", "💬", "🫶"];
        t = `${t} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`;
        t = clampConcise(t, maxLines);
    }
    return t;
}
function closeNicely(raw: string): string {
    let t = (raw || "").trim();
    if (!t) return t;
    if (/[.!?…]\s*$/.test(t)) return t;
    t = t.replace(/\s+[^\s]*$/, "").trim();
    if (!t) return raw.trim();
    return `${t}…`;
}

function normalizeToE164(n: string) { return String(n || "").replace(/[^\d]/g, ""); }

// ================== Imagen & Voz ==================
function mentionsImageExplicitly(t: string) {
    const s = String(t || "").toLowerCase();
    return (
        /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
        /(mira|revisa|checa|verifica)\s+la\s+(foto|imagen)/.test(s) ||
        /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
        /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
    );
}

async function pickImageForContext(opts: {
    conversationId: number;
    directUrl?: string | null;
    userText: string;
    caption: string;
    referenceTs: Date;
}) {
    const { conversationId, directUrl, userText, caption, referenceTs } = opts;

    if (directUrl) {
        return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "" };
    }

    if (!userText) return { url: null as string | null, noteToAppend: "" };

    // 1) Ventana corta
    const veryRecent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_CARRY_MS), lte: referenceTs },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });
    if (veryRecent?.mediaUrl) {
        const note = veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "";
        return { url: String(veryRecent.mediaUrl), noteToAppend: note };
    }

    // 2) Mención explícita → lookback más largo
    if (mentionsImageExplicitly(userText)) {
        const referenced = await prisma.message.findFirst({
            where: {
                conversationId,
                from: MessageFrom.client,
                mediaType: MediaType.image,
                timestamp: { gte: new Date(referenceTs.getTime() - IMAGE_LOOKBACK_MS), lte: referenceTs },
            },
            orderBy: { timestamp: "desc" },
            select: { mediaUrl: true, caption: true },
        });
        if (referenced?.mediaUrl) {
            const note = referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "";
            return { url: String(referenced.mediaUrl), noteToAppend: note };
        }
    }
    return { url: null as string | null, noteToAppend: "" };
}

// ================== Persistencia + envío WhatsApp ==================
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
    to?: string | null;
    phoneNumberId?: string | null;
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
            const resp = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId || undefined,
            });
            wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;

            if (!wamid && process.env.DEBUG_AI === "1") {
                console.error("[WAM send warning] No WAM ID in response:", JSON.stringify(resp));
            }

            if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
        } catch (e: any) {
            console.error("[WAM send error]", e?.response?.data || e?.message || e);
        }
    }
    return { messageId: msg.id, texto, wamid };
}

// ================== Historial compacto ==================
async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = 8) {
    const where: Prisma.MessageWhereInput = { conversationId };
    if (excludeMessageId) where.id = { not: excludeMessageId };

    const rows = await prisma.message.findMany({
        where,
        orderBy: { timestamp: "asc" },
        take,
        select: { from: true, contenido: true },
    });

    return rows.map((r) => ({
        role: r.from === MessageFrom.client ? "user" : "assistant",
        content: softTrim(r.contenido || "", 200),
    }));
}

function budgetMessages(messages: any[], budgetPromptTokens = 120) {
    const sys = messages.find((m: any) => m.role === "system");
    const user = messages.find((m: any) => m.role === "user");
    if (!sys) return messages;

    const sysText = String(sys.content || "");
    const userText =
        typeof user?.content === "string"
            ? user?.content
            : Array.isArray(user?.content)
                ? String(user?.content?.[0]?.text || "")
                : "";

    let total = approxTokens(sysText) + approxTokens(userText);
    for (const m of messages) {
        if (m.role !== "system" && m !== user) {
            const t =
                typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                        ? String(m.content?.[0]?.text || "")
                        : "";
            total += approxTokens(t);
        }
    }
    if (total <= budgetPromptTokens) return messages;

    // recorta el system a lo esencial
    const lines = sysText.split("\n").map((l: string) => l.trim()).filter(Boolean);
    const keep: string[] = [];
    for (const l of lines) {
        if (/clínica estética|agenda|servicios|precios|tono/i.test(l)) keep.push(l);
        if (keep.length >= 7) break;
    }
    (sys as any).content = keep.join("\n") || lines.slice(0, 7).join("\n");

    if (typeof user?.content === "string") {
        const ut = String(user.content);
        user.content = ut.length > 240 ? ut.slice(0, 240) : ut;
    } else if (Array.isArray(user?.content)) {
        const ut = String(user.content?.[0]?.text || "");
        (user.content as any[])[0].text = softTrim(ut, 240);
    }
    return messages;
}

// ================== Intents mínimos ==================
function isCatalogQuery(t: string) {
    const s = ` ${(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()} `;
    const nouns = ["servicio", "servicios", "procedimiento", "procedimientos", "tratamiento", "tratamientos", "catalogo", "catálogo"];
    const intents = ["que ", "qué ", "cuales", "cuáles", "lista", "disponible", "ofrecen", "tienes", "hay", "oferta", "precios", "precio"];
    const hitNoun = nouns.some((k) => s.includes(` ${k} `));
    const hitIntent = intents.some((k) => s.includes(k));
    return hitNoun || hitIntent;
}
function asksPrice(t: string) {
    const s = (t || "").toLowerCase();
    return /\b(precio|costo|valor|tarifa)\b/i.test(s) || /\bcu[aá]nto\s+(vale|sale)\b/i.test(s);
}

// ================== Tipos públicos ==================
export type IAReplyResult = {
    estado: ConversationEstado;
    mensaje: string;
    messageId?: number;
    wamid?: string;
    media?: any[];
};

// ================== Agente principal ==================
export async function handleEsteticaReply(args: {
    chatId: number;
    empresaId: number;
    mensajeArg?: string;
    toPhone?: string | null;
    phoneNumberId?: string | null;
}): Promise<IAReplyResult> {
    const { chatId, empresaId, mensajeArg = "", toPhone, phoneNumberId } = args;

    // Conversación + último inbound
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, estado: true, phone: true, empresaId: true },
    });
    if (!conversacion) return { estado: ConversationEstado.pendiente, mensaje: "" };

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

    // Idempotencia inbound
    if (last?.id && seenInboundRecently(last.id)) {
        return { estado: conversacion.estado, mensaje: "" };
    }

    // KB
    const kb = (await loadEsteticaKB({ empresaId, vertical: "estetica" })) as EsteticaKB | null;
    if (!kb) {
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: "Ahora mismo no tengo la configuración completa de la clínica. Te comunico con un asesor humano. 🙏",
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return { estado: ConversationEstado.requiere_agente, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // Texto del usuario: 1) mensajeArg 2) último texto guardado 3) transcripción si era voz
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
                    const name = last.mimeType?.includes("mpeg")
                        ? "audio.mp3"
                        : last.mimeType?.includes("wav")
                            ? "audio.wav"
                            : last.mimeType?.includes("m4a")
                                ? "audio.m4a"
                                : last.mimeType?.includes("webm")
                                    ? "audio.webm"
                                    : "audio.ogg";
                    transcript = await transcribeAudioBuffer(audioBuf, name);
                    if (transcript) await prisma.message.update({ where: { id: last.id }, data: { transcription: transcript } });
                }
            } catch (e) {
                if (process.env.DEBUG_AI === "1") console.error("[EST] Transcription error:", (e as any)?.message || e);
            }
        }
        if (transcript) userText = transcript;
    }

    const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
    const imageUrl = isImage ? String(last?.mediaUrl) : null;
    const caption = String(last?.caption || "").trim();
    const referenceTs = last?.timestamp ?? new Date();

    // Si llega solo imagen sin texto, espera breve a que escriban
    if (isImage && !caption && !userText) {
        await sleep(IMAGE_WAIT_MS);
        return { estado: conversacion.estado, mensaje: "" };
    }

    // ===== Intentos de agenda simples
    const looksLikeAgenda = /\b(cita|agendar|agenda|horario|disponibilidad|turno)\b/i.test(userText || caption);
    const serviceMatch = resolveServiceName(kb, userText || caption || "");
    const service = serviceMatch?.procedure ?? null;

    if (looksLikeAgenda) {
        const durationMin = service?.durationMin ?? kb.defaultServiceDurationMin ?? 45;
        const tz = kb.timezone || "America/Bogota";
        const bufferMin = kb.bufferMin ?? 10;

        // día siguiente (yyyy-MM-dd)
        const today = new Date();
        const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
        const y = next.getUTCFullYear();
        const m = String(next.getUTCMonth() + 1).padStart(2, "0");
        const d = String(next.getUTCDate()).padStart(2, "0");
        const startingDate = `${y}-${m}-${d}`;

        const found = await getNextAvailableSlots(
            { empresaId, vertical: "estetica", timezone: tz, bufferMin, granularityMin: 15 },
            startingDate,
            durationMin,
            14,
            6
        );

        if (found.length) {
            const pretty = found
                .map((day) => {
                    const times = day.slots.slice(0, 3).map((s) => s.startISO.slice(11, 16)).join(", ");
                    return `• ${day.date}: ${times}${day.slots.length > 3 ? "…" : ""}`;
                })
                .join("\n");

            const fromLabel = service ? serviceDisplayPrice(service) : null;
            const svcLine = service
                ? `Perfecto, para *${service.name}*${fromLabel ? ` (Desde ${fromLabel})` : ""}. `
                : "";

            const txt = `${svcLine}Puedo ofrecerte estos cupos próximos:\n\n${pretty}\n\n` +
                `Para reservar, dime cuál te sirve y tu *nombre* y *teléfono* para confirmarla.`;

            const saved = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto: txt,
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
        }
    }

    // ===== Catálogo / Precios
    if (isCatalogQuery(userText || caption || "")) {
        const procs = Array.isArray(kb.procedures) ? kb.procedures : [];
        if (!procs.length) {
            const savedEmpty = await persistBotReply({
                conversationId: chatId,
                empresaId,
                texto:
                    "Por ahora no veo servicios configurados para agendar. Si quieres, te doy orientación general y te ayudo a elegir. " +
                    "Si eres administrador, agrega procedimientos en *estetica_procedure* para que pueda listarlos aquí.",
                nuevoEstado: ConversationEstado.en_proceso,
                to: toPhone ?? conversacion.phone,
                phoneNumberId,
            });
            return { estado: ConversationEstado.en_proceso, mensaje: savedEmpty.texto, messageId: savedEmpty.messageId, wamid: savedEmpty.wamid, media: [] };
        }

        const list = procs
            .slice(0, 20)
            .map((p) => {
                const from = serviceDisplayPrice(p);
                return `• ${p.name}${from ? ` (Desde ${from})` : ""}`;
            })
            .join("\n");

        const txt = `Ofrecemos:\n\n${list}\n\n¿Quieres ver horarios para alguno?`;

        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: txt,
            nuevoEstado: ConversationEstado.en_proceso,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        return { estado: ConversationEstado.en_proceso, mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
    }

    // ===== LLM con imagen contextual
    let effectiveImageUrl = isImage ? imageUrl : null;
    let textForLLM = (userText || caption || "Hola").trim();
    if (!effectiveImageUrl && textForLLM) {
        const picked = await pickImageForContext({
            conversationId: chatId,
            directUrl: null,
            userText: textForLLM,
            caption,
            referenceTs,
        });
        effectiveImageUrl = picked.url;
        if (picked.noteToAppend) textForLLM = `${textForLLM}${picked.noteToAppend}`;
    }

    // ===== System prompt seguro
    type KBTexts = { businessOverview?: string; disclaimers?: string };
    type KBLogistics = { locationAddress?: string; locationName?: string };
    const businessName: string = (kb as any)?.businessName ?? "";
    const kbTexts: KBTexts | undefined = (kb as any)?.kbTexts ?? undefined;
    const logistics: KBLogistics | undefined = (kb as any)?.logistics ?? undefined;
    const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

    const system = [
        businessName ? `Agente de clínica estética de "${businessName}".` : `Agente de clínica estética.`,
        "Tono: humano, cercano y profesional. Nada robótico. Responde breve (2-5 líneas) y específica.",
        "Foco: orientación de tratamientos y agenda.",
        "Para *agendar* o *listar* procedimientos usa solo los de la base de datos.",
        "Si preguntan por precio, usa el formato: \"Desde $X (COP)\" con priceMin.",
        "Si notas intención de agendar, ofrece 3 a 5 horarios próximos (usa 'Puedo ofrecerte…').",
        kbTexts?.businessOverview ? `Contexto: ${softTrim(kbTexts.businessOverview, 220)}` : "",
        logistics?.locationAddress ? `Dirección: ${logistics.locationAddress}` : "",
        logistics?.locationName ? `Sede: ${logistics.locationName}` : "",
        kbTexts?.disclaimers ? `Avisos: ${softTrim(kbTexts.disclaimers, 180)}` : "",
        "Evita pedir 'más información' de forma genérica. Si falta un dato, pregunta 1 cosa concreta.",
    ].filter(isString).join("\n");

    const history = await getRecentHistory(chatId, last?.id, 8);
    const messages: any[] = [{ role: "system", content: system }, ...history];
    if (effectiveImageUrl) {
        messages.push({
            role: "user",
            content: [
                { type: "text", text: textForLLM || "Hola" },
                { type: "image_url", image_url: { url: effectiveImageUrl } },
            ],
        });
    } else {
        messages.push({ role: "user", content: textForLLM || "Hola" });
    }
    budgetMessages(messages, 120);

    const model = process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini";
    const temperature = Number(process.env.IA_TEMPERATURE ?? 0.4);

    let texto = "";
    try {
        const resp = await (openai.chat.completions.create as any)({
            model, temperature, max_tokens: IA_MAX_TOKENS, messages,
        });
        texto = resp?.choices?.[0]?.message?.content?.trim() || "";
    } catch {
        texto = "Te ayudo con estética y agenda. Si quieres, te paso horarios.";
    }

    // Blindaje de montos inventados si no pidieron precio
    if (!asksPrice(userText || caption || "")) {
        if (KB_MONEY_RE.test(texto)) texto = texto.replace(KB_MONEY_RE, "consulta por precio");
    }

    texto = closeNicely(texto);
    texto = formatConcise(texto, IA_MAX_LINES, IA_MAX_CHARS, IA_ALLOW_EMOJI);

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
}

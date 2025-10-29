// // utils/ai/strategies/estetica.strategy.ts
// import axios from "axios";
// import prisma from "../../../lib/prisma";
// import {
//     ConversationEstado,
//     MediaType,
//     MessageFrom,
// } from "@prisma/client";
// import { openai } from "../../../lib/openai";
// import * as Wam from "../../../services/whatsapp.service";
// import { transcribeAudioBuffer } from "../../../services/transcription.service";
// import {
//     loadEsteticaKB,
//     resolveServiceName,
//     type EsteticaKB,
// } from "./esteticaModules/domain/estetica.kb";

// /* ==== CONFIG ==== */
// const CONF = {
//     MEM_TTL_MIN: 60,
//     GRAN_MIN: 15,
//     MAX_HISTORY: 20,
//     REPLY_MAX_LINES: 5,
//     REPLY_MAX_CHARS: 900,
//     TEMPERATURE: 0.3,
//     MODEL: process.env.IA_TEXT_MODEL || "gpt-4o-mini",
// };

// const IMAGE_WAIT_MS = 1000;
// const IMAGE_CARRY_MS = 60_000;
// const IMAGE_LOOKBACK_MS = 300_000;
// const REPLY_DEDUP_WINDOW_MS = 120_000;

// /* ===== UTILS ===== */
// function sleep(ms: number) {
//     return new Promise((r) => setTimeout(r, ms));
// }
// const processedInbound = new Map<number, number>();
// function seenInboundRecently(mid: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
//     const now = Date.now();
//     const prev = processedInbound.get(mid);
//     if (prev && now - prev <= windowMs) return true;
//     processedInbound.set(mid, now);
//     return false;
// }

// /** Conversational dedup (double-reply window per conversation) */
// const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
// function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = 120_000) {
//     const now = Date.now();
//     const prev = recentReplies.get(conversationId);
//     if (prev && prev.afterMs >= clientTs.getTime() && now - prev.repliedAtMs <= windowMs) return true;
//     recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
//     return false;
// }
// function markActuallyReplied(conversationId: number, clientTs: Date) {
//     recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: Date.now() });
// }

// /** Detecta si el mensaje es nota de voz o audio */
// function isVoiceInbound(last: { isVoiceNote?: boolean | null; mediaType?: any; mimeType?: string | null; }) {
//     if (last?.isVoiceNote) return true;
//     const mt = String(last?.mediaType ?? "").toLowerCase();
//     if (mt === "audio" || mt === "voice") return true;
//     return (last?.mimeType || "").startsWith("audio/");
// }

// /** Busca imagen contextual */
// async function pickImageForContext({
//     conversationId,
//     userText,
//     caption,
//     referenceTs,
// }: {
//     conversationId: number;
//     userText: string;
//     caption: string;
//     referenceTs: Date;
// }) {
//     const s = userText.toLowerCase();
//     const mentionsImg =
//         /\b(foto|imagen|selfie|captura)\b/.test(s) ||
//         /(mira|env[ií]e)\s+(la\s+)?(foto|imagen)/.test(s);

//     const recent = await prisma.message.findFirst({
//         where: {
//             conversationId,
//             from: MessageFrom.client,
//             mediaType: MediaType.image,
//             timestamp: {
//                 gte: new Date(referenceTs.getTime() - (mentionsImg ? IMAGE_LOOKBACK_MS : IMAGE_CARRY_MS)),
//                 lte: referenceTs,
//             },
//         },
//         orderBy: { timestamp: "desc" },
//         select: { mediaUrl: true, caption: true },
//     });

//     if (recent?.mediaUrl) {
//         const note = recent.caption ? `\n\nNota de la imagen: ${recent.caption}` : "";
//         return { url: recent.mediaUrl, noteToAppend: note };
//     }
//     return { url: null, noteToAppend: "" };
// }

// /* ======= STATE (conversation_state) ======= */
// type AgentState = {
//     greeted?: boolean;
//     lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
//     lastServiceId?: number | null;
//     lastServiceName?: string | null;
//     draft?: {
//         name?: string;
//         phone?: string;
//         procedureId?: number;
//         procedureName?: string;
//         whenISO?: string;
//         whenText?: string; // fecha/hora “tal cual” que escribió el cliente (sin calcular)
//         // NOTA: no usamos timeHHMM ni timeNote para no “inferir” horas
//     };
//     summary?: { text: string; expiresAt: string };
//     expireAt?: string;
//     handoffLocked?: boolean;
// };
// function nowPlusMin(min: number) {
//     return new Date(Date.now() + min * 60_000).toISOString();
// }
// async function loadState(conversationId: number): Promise<AgentState> {
//     const row = await prisma.conversationState.findUnique({
//         where: { conversationId },
//         select: { data: true },
//     });
//     const raw = (row?.data as any) || {};
//     const data: AgentState = {
//         greeted: !!raw.greeted,
//         lastIntent: raw.lastIntent,
//         lastServiceId: raw.lastServiceId ?? null,
//         lastServiceName: raw.lastServiceName ?? null,
//         draft: raw.draft ?? {},
//         summary: raw.summary ?? undefined,
//         expireAt: raw.expireAt,
//         handoffLocked: !!raw.handoffLocked,
//     };
//     const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
//     if (expired) return { greeted: data.greeted, handoffLocked: data.handoffLocked, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
//     return data;
// }
// async function saveState(conversationId: number, data: AgentState) {
//     const next: AgentState = { ...data, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
//     await prisma.conversationState.upsert({
//         where: { conversationId },
//         create: { conversationId, data: next as any },
//         update: { data: next as any },
//     });
// }
// async function patchState(conversationId: number, patch: Partial<AgentState>) {
//     const prev = await loadState(conversationId);
//     await saveState(conversationId, { ...prev, ...patch });
// }

// /* ===== Helpers para agenda (DB) ===== */
// function pad2(n: number) { return String(n).padStart(2, "0"); }
// function hhmmFrom(raw?: string | null) {
//     if (!raw) return null;
//     const m = raw.match(/^(\d{1,2})(?::?(\d{2}))?/);
//     if (!m) return null;
//     const hh = Math.min(23, Number(m[1] ?? 0));
//     const mm = Math.min(59, Number(m[2] ?? 0));
//     return `${pad2(hh)}:${pad2(mm)}`;
// }
// function weekdayToDow(day: any): number | null {
//     const key = String(day || "").toUpperCase();
//     const map: Record<string, number> = {
//         SUNDAY: 0, DOMINGO: 0,
//         MONDAY: 1, LUNES: 1,
//         TUESDAY: 2, MARTES: 2,
//         WEDNESDAY: 3, MIERCOLES: 3, MIÉRCOLES: 3,
//         THURSDAY: 4, JUEVES: 4,
//         FRIDAY: 5, VIERNES: 5,
//         SATURDAY: 6, SABADO: 6, SÁBADO: 6,
//     };
//     return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
// }
// async function fetchAppointmentHours(empresaId: number) {
//     const rows = await prisma.appointmentHour.findMany({
//         where: { empresaId },
//         orderBy: [{ day: "asc" }],
//         select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
//     });
//     return rows;
// }
// async function fetchAppointmentExceptions(empresaId: number, horizonDays = 35) {
//     const now = new Date();
//     const end = new Date(now);
//     end.setDate(end.getDate() + horizonDays);
//     try {
//         const rows: any[] = await (prisma as any).appointment_exeption.findMany({
//             where: { empresaId, date: { gte: now, lte: end } },
//             orderBy: [{ date: "asc" }],
//             select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
//         });
//         return rows;
//     } catch {
//         try {
//             const rows: any[] = await (prisma as any).appointment_exception.findMany({
//                 where: { empresaId, date: { gte: now, lte: end } },
//                 orderBy: [{ date: "asc" }],
//                 select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
//             });
//             return rows;
//         } catch {
//             return [];
//         }
//     }
// }
// function normalizeHours(rows: any[]) {
//     const byDow: Record<number, Array<{ start: string; end: string }>> = {};
//     for (const r of rows || []) {
//         if (!r) continue;
//         if (r.isOpen === false) continue;
//         const dow = weekdayToDow(r.day);
//         if (dow == null) continue;
//         const s1 = hhmmFrom(r.start1), e1 = hhmmFrom(r.end1);
//         const s2 = hhmmFrom(r.start2), e2 = hhmmFrom(r.end2);
//         if (s1 && e1) (byDow[dow] ||= []).push({ start: s1, end: e1 });
//         if (s2 && e2) (byDow[dow] ||= []).push({ start: s2, end: e2 });
//     }
//     return byDow;
// }
// function normalizeExceptions(rows: any[]) {
//     const items: Array<{ date: string; closed: boolean; motivo?: string }> = [];
//     for (const r of rows || []) {
//         const closed = (r.isOpen === false) || (r.closed === true) || (r.open === false);
//         const date = r.dateISO ?? (r.date ? new Date(r.date).toISOString().slice(0, 10) : null);
//         if (!date) continue;
//         items.push({ date, closed, motivo: r.motivo ?? r.reason });
//     }
//     return items;
// }

// /* ===== INTENT DETECTOR (no forzar agenda) ===== */

// /* ==== INFO / SCHEDULE GUARDS (del componente viejo) ==== */
// function isSchedulingCue(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return (
//         /\b(agendar|agenda|reservar|programar)\b/.test(s) ||
//         /quieres ver horarios|te paso horarios|dime el dia y hora|que dia y hora prefieres/.test(s)
//     );
// }

// function isShortQuestion(t: string): boolean {
//     const s = (t || "").trim();
//     const noSpaces = s.replace(/\s+/g, "");
//     const hasQM = /[?¿]/.test(s);
//     return hasQM && s.length <= 120 && noSpaces.length >= 2;
// }

// function containsDateOrTimeHints(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return (
//         /\b(hoy|manana|mañana|proxima|semana|lunes|martes|miercoles|jueves|viernes|sabado|sábado|domingo|am|pm|a las|hora|tarde|noche|mediodia|medio dia)\b/.test(s) ||
//         /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(s) ||
//         /\b(\d{1,2}:\d{2})\b/.test(s)
//     );
// }

// function isPaymentQuestion(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return /\b(pagos?|metodos? de pago|tarjeta|efectivo|transferencia|nequi|daviplata|pse)\b/.test(s);
// }

// function isGeneralInfoQuestion(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return (
//         /\b(que es|de que se trata|como funciona|beneficios?|riesgos?|efectos secundarios?|contraindicaciones?|cuidados|cuanto dura|duracion|quien lo hace|profesional|doctor(a)?)\b/.test(s) ||
//         /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|sede|como llego|parqueadero)\b/.test(s) ||
//         isPaymentQuestion(t)
//     );
// }

// function isEducationalQuestion(text: string): boolean {
//     const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     if (/\b(que es|de que se trata|como funciona|como actua|beneficios?|riesgos?|efectos secundarios?|cuidados|contraindicaciones?)\b/.test(t)) return true;
//     if (/\b(b[óo]tox|toxina|acido hialuronico|peeling|manchas|acne|rosacea|melasma|flacidez)\b/.test(t)) return true;
//     if (/\b(recomendable|sirve|me ayuda)\b/.test(t) && /\b(rosacea|acne|melasma|cicatriz|flacidez|arrugas|manchas)\b/.test(t)) return true;
//     return false;
// }

// function shouldBypassScheduling(t: string): boolean {
//     if (isSchedulingCue(t) || containsDateOrTimeHints(t)) return false; // señales claras → sí agenda
//     if (isShortQuestion(t) || isGeneralInfoQuestion(t) || isEducationalQuestion(t)) return true; // informativo → NO agenda
//     return false;
// }


// type Intent = "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";

// function detectIntent(text: string, draft: AgentState["draft"]): Intent {
//     const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

//     // señales de agenda explícita
//     const scheduleHints = [
//         "agendar", "agendo", "agendemos", "agenda", "cita", "programar", "reservar", "reserva",
//         "disponible", "disponibilidad", "horario", "hora", "dia", "fecha", "cuando atienden", "para el",
//         "quiero ir", "puedo ir", "mañana", "manana", "tarde", "noche", "am", "pm", "a las"
//     ];
//     if (scheduleHints.some(h => t.includes(h))) return "schedule";


//     // Si ya trajo alguna pieza REAL de agenda (servicio o fecha/hora), seguimos en schedule
//     if (draft?.procedureId || draft?.procedureName || draft?.whenText || draft?.whenISO) return "schedule";


//     // precio/costo
//     if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";

//     // reprogramación / cancelación
//     if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
//     if (/\b(cancelar|anular)\b/.test(t)) return "cancel";

//     // preguntas tipo “¿qué es?”, “¿cómo funciona?”
//     if (/\b(que es|como funciona|efectos|riesgos|duracion|contraindicaciones|recomendaciones)\b/.test(t)) return "info";

//     // saludo/otros → libre
//     return "other";
// }


// /* ===== Summary extendido con cache en conversation_state ===== */
// function softTrim(s: string | null | undefined, max = 240) {
//     const t = (s || "").trim();
//     if (!t) return "";
//     return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
// }
// function formatCOP(value?: number | null): string | null {
//     if (value == null || isNaN(Number(value))) return null;
//     return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
// }
// async function buildBusinessRangesHuman(
//     empresaId: number,
//     kb: EsteticaKB,
//     opts?: { defaultDurMin?: number; rows?: any[] }
// ): Promise<{ human: string; lastStart?: string }> {
//     const rows = opts?.rows ?? await fetchAppointmentHours(empresaId);
//     const byDow = normalizeHours(rows);
//     const dayShort = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

//     const parts: string[] = [];
//     for (let d = 0; d < 7; d++) {
//         const ranges = byDow[d];
//         if (ranges?.length) parts.push(`${dayShort[d]} ${ranges.map(r => `${r.start}–${r.end}`).join(", ")}`);
//     }
//     const human = parts.join("; ");

//     const dur = Math.max(30, opts?.defaultDurMin ?? (kb.defaultServiceDurationMin ?? 60));
//     const weekdays = [1, 2, 3, 4, 5];
//     const endsWeekdays: string[] = [];
//     const endsAll: string[] = [];

//     for (const d of weekdays) for (const r of (byDow[d] || [])) if (r.end) endsWeekdays.push(r.end);
//     for (let d = 0; d < 7; d++) for (const r of (byDow[d] || [])) if (r.end) endsAll.push(r.end);
//     const pool = endsWeekdays.length ? endsWeekdays : endsAll;
//     if (!pool.length) return { human, lastStart: undefined };

//     const maxEnd = pool.sort()[pool.length - 1];
//     const [eh, em] = maxEnd.split(":").map(Number);
//     const startMins = eh * 60 + em - dur;
//     const sh = Math.max(0, Math.floor(startMins / 60));
//     const sm = Math.max(0, startMins % 60);
//     const lastStart = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;

//     return { human, lastStart };
// }
// function paymentMethodsFromKB(kb: EsteticaKB): string[] {
//     const list: string[] = [];
//     const pm: any = (kb as any).paymentMethods ?? (kb as any).payments ?? [];
//     if (Array.isArray(pm)) {
//         for (const it of pm) {
//             if (!it) continue;
//             if (typeof it === "string") list.push(it);
//             else if (typeof it?.name === "string") list.push(it.name);
//         }
//     }
//     const flags: Array<[string, any]> = [
//         ["Efectivo", (kb as any).cash],
//         ["Tarjeta débito/crédito", (kb as any).card || (kb as any).cards],
//         ["Transferencia", (kb as any).transfer || (kb as any).wire],
//         ["PSE", (kb as any).pse],
//         ["Nequi", (kb as any).nequi],
//         ["Daviplata", (kb as any).daviplata],
//     ];
//     for (const [label, v] of flags) if (v === true) list.push(label);
//     return Array.from(new Set(list)).sort();
// }

// async function buildOrReuseSummary(args: {
//     empresaId: number;
//     conversationId: number;
//     kb: EsteticaKB;
// }): Promise<string> {
//     const { empresaId, conversationId, kb } = args;

//     const cached = await loadState(conversationId);
//     const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
//     if (fresh) return cached.summary!.text;

//     const [hoursRows, exceptionsRows, apptCfg] = await Promise.all([
//         fetchAppointmentHours(empresaId),
//         fetchAppointmentExceptions(empresaId, 35),
//         prisma.businessConfigAppt.findUnique({
//             where: { empresaId },
//             select: {
//                 appointmentEnabled: true,
//                 appointmentTimezone: true,
//                 appointmentBufferMin: true,
//                 appointmentMinNoticeHours: true,
//                 appointmentMaxAdvanceDays: true,
//                 allowSameDayBooking: true,
//                 defaultServiceDurationMin: true,
//                 appointmentPolicies: true,
//                 locationName: true,
//                 locationAddress: true,
//                 locationMapsUrl: true,
//                 parkingInfo: true,
//                 instructionsArrival: true,
//                 noShowPolicy: true,
//                 depositRequired: true,
//                 depositAmount: true,
//                 servicesText: true,
//                 services: true,
//                 kbBusinessOverview: true,
//                 kbFAQs: true,
//                 kbServiceNotes: true,
//                 kbEscalationRules: true,
//                 kbDisclaimers: true,
//                 kbMedia: true,
//                 kbFreeText: true,
//             },
//         }),
//     ]);

//     const { human: hoursLine, lastStart } = await buildBusinessRangesHuman(empresaId, kb, { rows: hoursRows });
//     const exceptions = normalizeExceptions(exceptionsRows);
//     const exLine = exceptions.filter(e => e.closed).slice(0, 10).map(e => e.date).join(", ");
//     const exceptionsLine = exLine ? `Excepciones (cerrado): ${exLine}` : "";

//     const svcFromKB = (kb.procedures ?? [])
//         .filter(s => s.enabled !== false)
//         .map(s => (s.priceMin ? `${s.name} (Desde ${formatCOP(s.priceMin)})` : s.name))
//         .join(" • ");

//     const payments = paymentMethodsFromKB(kb);
//     const paymentsLine = payments.length ? `Pagos: ${payments.join(" • ")}` : "";

//     const msgs = await prisma.message.findMany({
//         where: { conversationId },
//         orderBy: { timestamp: "desc" },
//         take: 10,
//         select: { from: true, contenido: true },
//     });
//     const history = msgs
//         .reverse()
//         .map((m) => `${m.from === MessageFrom.client ? "U" : "A"}: ${softTrim(m.contenido || "", 100)}`)
//         .join(" | ");

//     const S = apptCfg || ({} as any);

//     // ==== Normalizar FAQs (acepta array de {q,a}, array de strings, o objeto mapa) ====
//     // ==== Normalizar FAQs (acepta JSON string, array {q,a}, array<string> "P|R", u objeto mapa) ====
//     type FAQ = { q: string; a: string };

//     // NEW: intenta parsear si viene como string JSON (tu caso)
//     function parseMaybeJson<T = any>(val: any): T | any {
//         if (typeof val === "string") {
//             try { return JSON.parse(val); } catch { /* deja pasar */ }
//         }
//         return val;
//     }

//     function toFaqArray(src: any): FAQ[] {
//         const v = parseMaybeJson(src);
//         if (!v) return [];

//         if (Array.isArray(v)) {
//             if (v.length && typeof v[0] === "string") {
//                 // ["Pregunta|Respuesta", ...]
//                 return v.map((s: string) => {
//                     const [q, a] = String(s).split("|");
//                     return { q: (q || "").trim(), a: (a || "").trim() };
//                 }).filter(f => f.q && f.a);
//             }
//             if (v.length && typeof v[0] === "object") {
//                 // [{q, a}, ...]
//                 return v.map((o: any) => ({
//                     q: String(o?.q || "").trim(),
//                     a: String(o?.a || "").trim(),
//                 })).filter(f => f.q && f.a);
//             }
//         }

//         if (typeof v === "object") {
//             // { "¿Pregunta?": "Respuesta", ... }
//             return Object.entries(v).map(([q, a]) => ({
//                 q: String(q).trim(),
//                 a: String(a ?? "").trim(),
//             })).filter(f => f.q && f.a);
//         }

//         if (typeof v === "string") {
//             // Texto plano "P|R\nP|R..."
//             return v.split(/\r?\n/).map(l => {
//                 const [q, a] = l.split("|");
//                 return { q: (q || "").trim(), a: (a || "").trim() };
//             }).filter(f => f.q && f.a);
//         }

//         return [];
//     }

//     // NEW: fusiona fuentes y deduplica por pregunta
//     const faqsFromCfg = toFaqArray(S.kbFAQs);            // <- viene de DB (puede ser string JSON)
//     const faqsFromKB1 = toFaqArray((kb as any).kbFAQs);  // <- por si tu loader también lo trajo
//     const faqsFromKB2 = toFaqArray((kb as any).faqs);    // <- loader ya parseado

//     const seen = new Set<string>();
//     const faqsArr = [...faqsFromCfg, ...faqsFromKB1, ...faqsFromKB2]
//         .filter(f => f && f.q && f.a)
//         .filter(f => {
//             const k = f.q.trim().toLowerCase();
//             if (seen.has(k)) return false;
//             seen.add(k);
//             return true;
//         });

//     // (opcional) debug
//     console.log("FAQs sizes =>", {
//         cfg: faqsFromCfg.length,
//         kb1: faqsFromKB1.length,
//         kb2: faqsFromKB2.length,
//         merged: faqsArr.length,
//     });



//     const faqsLine = faqsArr.length
//         ? "FAQs: " +
//         faqsArr
//             .slice(0, 5) // solo las 5 más relevantes/primeras
//             .map(f => `${softTrim(f.q, 60)} → ${softTrim(f.a, 120)}`)
//             .join(" | ")
//         : "";

//     // ——— PREMIUM SUMMARY BUILDER ———
//     function icon(label: "biz" | "tz" | "agenda" | "rules" | "log" | "pol" | "pay" | "svc" | "hrs" | "exc" | "faq" | "note" | "hist") {
//         const map = {
//             biz: "🏥", tz: "🌐", agenda: "⏰", rules: "📋", log: "📍", pol: "🧾",
//             pay: "💳", svc: "✨", hrs: "🕒", exc: "🚫", faq: "💬", note: "📝", hist: "🧠"
//         } as const;
//         return map[label];
//     }

//     // 1) Secciones con bullets bonitos y líneas cortas
//     const lines: string[] = [];
//     lines.push(`${icon("biz")} *${kb.businessName || "Clínica estética"}*`);
//     lines.push(`${icon("tz")} Zona horaria: ${S.appointmentTimezone || kb.timezone}`);

//     const rulesArr = [
//         S.appointmentEnabled != null ? `Agenda: ${S.appointmentEnabled ? "habilitada" : "deshabilitada"}` : "",
//         (S.appointmentBufferMin ?? kb.bufferMin) != null ? `Buffer: ${S.appointmentBufferMin ?? kb.bufferMin} min` : "",
//         S.allowSameDayBooking != null ? `Mismo día: ${S.allowSameDayBooking ? "sí" : "no"}` : "",
//         S.appointmentMinNoticeHours != null ? `Anticipación: ${S.appointmentMinNoticeHours} h` : "",
//         S.appointmentMaxAdvanceDays != null ? `Hasta: ${S.appointmentMaxAdvanceDays} días` : "",
//     ].filter(Boolean);
//     if (rulesArr.length) lines.push(`${icon("rules")} ${rulesArr.join(" · ")}`);

//     const logArr = [
//         S.locationName ? `Sede: ${S.locationName}` : "",
//         S.locationAddress ? `Dir: ${S.locationAddress}` : "",
//         S.locationMapsUrl ? `Mapa: ${S.locationMapsUrl}` : "",
//         S.parkingInfo ? `Parqueadero: ${softTrim(S.parkingInfo, 120)}` : "",
//         S.instructionsArrival ? `Ingreso: ${softTrim(S.instructionsArrival, 120)}` : "",
//     ].filter(Boolean);
//     if (logArr.length) lines.push(`${icon("log")} ${logArr.join(" · ")}`);

//     if (S.noShowPolicy || S.depositRequired != null) {
//         const pols = [
//             S.noShowPolicy ? `No-show: ${softTrim(S.noShowPolicy, 120)}` : "",
//             S.depositRequired ? `Depósito: ${S.depositAmount ? formatCOP(Number(S.depositAmount)) : "sí"}` : "Depósito: no",
//         ].filter(Boolean);
//         lines.push(`${icon("pol")} ${pols.join(" · ")}`);
//     }

//     if (payments.length) lines.push(`${icon("pay")} Pagos: ${payments.join(" • ")}`);

//     const svcList = (kb.procedures ?? [])
//         .filter(s => s.enabled !== false)
//         .slice(0, 6)
//         .map(s => s.priceMin ? `${s.name} (desde ${formatCOP(s.priceMin)})` : s.name)
//         .join(" • ");
//     if (svcList) lines.push(`${icon("svc")} Servicios: ${svcList}`);

//     if (hoursLine) lines.push(`${icon("hrs")} Horario: ${hoursLine}${lastStart ? `; última cita ref. ${lastStart}` : ""}`);
//     if (exceptionsLine) lines.push(`${icon("exc")} ${exceptionsLine}`);

//     // FAQs (máx 5) en bullets de 1 línea
//     if (faqsArr.length) {
//         lines.push(`${icon("faq")} *FAQs rápidas*`);
//         for (const f of faqsArr.slice(0, 5)) {
//             lines.push(`• ${softTrim(f.q, 60)} → ${softTrim(f.a, 140)}`);
//         }
//     }

//     if (S.kbBusinessOverview) lines.push(`${icon("note")} ${softTrim(S.kbBusinessOverview, 260)}`);
//     if (S.kbFreeText) lines.push(`${icon("note")} ${softTrim(S.kbFreeText, 260)}`);

//     // Historial ultra breve
//     lines.push(`${icon("hist")} Historial: ${history || "—"}`);

//     // Compacta y recorta
//     let compact = lines.join("\n").replace(/\n{3,}/g, "\n\n");
//     compact = softTrim(compact, 1000); // seguridad para no crecer demasiado

//     await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
//     return compact;
// }

// /* ===== Detección de handoff listo (nombre + fecha/hora textual + procedimiento) ===== */
// function detectHandoffReady(t: string) {
//     const text = (t || "").toLowerCase();

//     const hasName =
//         /\bmi\s+nombre\s+es\s+[a-záéíóúñü\s]{3,}/i.test(t) ||
//         /\bsoy\s+[a-záéíóúñü\s]{3,}/i.test(t);

//     const hasDateOrTimeText =
//         /\b(hoy|mañana|manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|am|pm|tarde|mañana|manana|noche|mediod[ií]a|medio\s+dia)\b/.test(text) ||
//         /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(text) ||
//         /\b(\d{1,2}[:.]\d{2}\s*(am|pm)?)\b/.test(text);

//     const hasProc =
//         /\b(botox|toxina|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|laser|plasma|hilos|armonizaci[oó]n|mesoterapia)\b/.test(
//             text
//         );

//     return hasName && hasDateOrTimeText && hasProc;
// }

// /* ===== Extractores suaves para el borrador (sin normalizar hora) ===== */
// /* ===== Extractores suaves para el borrador (sin normalizar hora) ===== */
// function normalizeName(n: string) {
//     return n
//         .trim()
//         .replace(/\s+/g, " ")
//         .split(" ")
//         .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
//         .join(" ");
// }

// function extractName(raw: string): string | null {
//     const t = (raw || "").trim();

//     // Patrones explícitos
//     let m =
//         t.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,3})\b/i) ||
//         t.match(/^\s*nombre\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,3})\s*$/i);

//     if (m && m[1]) {
//         const name = normalizeName(m[1]);
//         // evita capturar palabras típicas de agenda
//         if (/\b(viernes|sábado|sabado|lunes|martes|miércoles|miercoles|jueves|hoy|mañana|manana)\b/i.test(name)) return null;
//         if (/\b(botox|toxina|peeling|limpieza|relleno|hialuronico|hialurónico)\b/i.test(name)) return null;
//         return name;
//     }

//     // Sin disparador, NO asumir nombre (elimina falsos positivos tipo “Botox para este viernes”)
//     return null;
// }
// function looksLikeLooseName(raw: string): string | null {
//     const t = (raw || "").trim();

//     // descartar si trae números o símbolos fuertes
//     if (/[0-9@#]/.test(t)) return null;

//     // 1–4 palabras, solo letras y espacios
//     const parts = t.split(/\s+/).filter(Boolean);
//     if (parts.length < 2 || parts.length > 4) return null;

//     // evitar falsos positivos: días, horarios, procedimientos comunes
//     const bad = /\b(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|hoy|mañana|manana|tarde|noche|am|pm|a las|botox|toxina|peeling|limpieza|relleno|hialuronico|hialurónico)\b/i;
//     if (bad.test(t.toLowerCase())) return null;

//     // solo letras (con tildes) y espacios
//     if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñü\s]+$/.test(t)) return null;

//     // capitaliza
//     const normalized = t
//         .replace(/\s+/g, " ")
//         .split(" ")
//         .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
//         .join(" ");

//     return normalized;
// }


// function grabWhenFreeText(raw: string): string | null {
//     const t = (raw || "").toLowerCase();
//     const hints = [
//         "hoy", "mañana", "manana", "próxima", "proxima", "semana", "mes", "mediodia", "medio dia",
//         "lunes", "martes", "miércoles", "miercoles", "jueves", "viernes", "sábado", "sabado",
//         "am", "pm", "a las", "hora", "tarde", "noche", "domingo"
//     ];
//     const looksLikeDate = /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/.test(t);
//     const hasHint = hints.some(h => t.includes(h));
//     return (looksLikeDate || hasHint) ? softTrim(raw, 120) : null;
// }
// function hasSomeDateDraft(d?: AgentState["draft"]) {
//     return !!(d?.whenISO || d?.whenText);
// }
// function sanitizeGreeting(text: string) {
//     // Quita signos iniciales y espacios antes del saludo
//     let s = (text || "").replace(/^[\s¡!¿?'"()\-–—]+/g, "").trim();

//     // Saludos típicos al inicio, con o sin signos
//     const patterns = [
//         /^(?:hola|holi|hey|buen(?:os|as)?\s+(?:d[ií]as|tardes|noches)|qué tal|que tal|hola hola)[\s,.:;!¡¿?–—-]*/i,
//     ];
//     for (const rx of patterns) s = s.replace(rx, "").trim();

//     // Si todavía arranca con un segundo “¡Hola!” (ej. LLM), intenta de nuevo
//     s = s.replace(/^(?:¡\s*)?hola[!\s,.:;¡¿?–—-]*/i, "").trim();

//     return s || text;
// }

// function prependFirstGreeting(text: string, greeted?: boolean, conversationId?: number) {
//     if (greeted) return text;
//     const base = "¡Hola! ¿En qué puedo ayudarte?";
//     // Reusa tu emoji estable
//     const withEmoji = addEmojiStable(base, conversationId ?? 0);
//     const clean = sanitizeGreeting(text || "");
//     return `${withEmoji}\n${clean}`.trim();
// }



// /* ===== FORMATO / RESPUESTA ===== */
// function clampText(t: string, lines = CONF.REPLY_MAX_LINES, chars = CONF.REPLY_MAX_CHARS) {
//     let txt = (t || "").trim();
//     if (!txt) return txt;
//     const arr = txt.split("\n").filter(Boolean);
//     if (arr.length > lines) txt = arr.slice(0, lines).join("\n");
//     if (txt.length > chars) txt = txt.slice(0, chars - 3) + "…";
//     return txt;
// }

// /** Normaliza texto para deduplicación (insensible a mayúsculas, tildes y espacios) */
// function normalizeForDedup(s: string) {
//     return (s || "")
//         .toLowerCase()
//         .normalize("NFD")
//         .replace(/\p{Diacritic}/gu, "")     // quita tildes
//         .replace(/[\s\n\r]+/g, " ")         // colapsa espacios
//         .replace(/[^\p{L}\p{N}\s]/gu, "")   // quita signos/emoji para comparar
//         .trim();
// }


// /** Un solo emoji “premium” por conversación (estable) */
// function addEmojiStable(text: string, conversationId: number) {
//     const base = (Number.isFinite(conversationId) ? conversationId : 0) >>> 0;
//     const emojis = ["✨", "👌", "🙂", "🫶", "💬"]; // paleta más sobria
//     const idx = base % emojis.length;
//     if (/[✨👌🙂🫶💬]/.test(text)) return text; // ya hay uno de la paleta
//     return `${text} ${emojis[idx]}`;
// }



// /* ===== PERSISTENCIA ===== */
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
// }: any) {
//     // dedup suave con el último del bot:
//     const prevBot = await prisma.message.findFirst({
//         where: { conversationId, from: MessageFrom.bot },
//         orderBy: { timestamp: "desc" },
//         select: { id: true, contenido: true, timestamp: true, externalId: true },
//     });
//     if (prevBot) {
//         const sameText =
//             normalizeForDedup(prevBot.contenido || "") === normalizeForDedup(texto || "");
//         const recent = Date.now() - new Date(prevBot.timestamp as any).getTime() <= 15_000;
//         if (sameText && recent) {
//             await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
//             return { messageId: prevBot.id, texto: prevBot.contenido, wamid: prevBot.externalId as any, estado: nuevoEstado };
//         }
//     }

//     const msg = await prisma.message.create({
//         data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
//     });
//     await prisma.conversation.update({
//         where: { id: conversationId },
//         data: { estado: nuevoEstado },
//     });
//     let wamid: string | undefined;
//     if (to) {
//         try {
//             const r = await Wam.sendWhatsappMessage({
//                 empresaId,
//                 to: normalizeToE164(to),
//                 body: texto,
//                 phoneNumberIdHint: phoneNumberId,
//             });
//             wamid = r?.data?.messages?.[0]?.id;
//             if (wamid)
//                 await prisma.message.update({
//                     where: { id: msg.id },
//                     data: { externalId: wamid },
//                 });
//         } catch { }
//     }
//     return { texto, wamid, messageId: msg.id };
// }

// /* ===== OOT (fuera de alcance) ===== */
// function isOutOfScope(text: string) {
//     const t = (text || "").toLowerCase();
//     const allowed =
//         /(est[eé]tica|cl[ií]nica|botox|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|l[aá]ser|plasma|hilos|armonizaci[oó]n|mesoterapia|facial|corporal|agenda|cita|precio|valoraci[oó]n)/i;
//     const disallowed =
//         /(finanzas|banco|cript|programaci[oó]n|servidor|vercel|render|pol[ií]tica|relig|tarea de colegio|matem[aá]ticas|qu[ií]mica|f[úu]tbol|tr[aá]mite|veh[ií]culo)/i;
//     return !allowed.test(t) && disallowed.test(t);
// }

// /* ===== LLM ===== */
// async function runLLM({ summary, userText, imageUrl }: any) {
//     const sys = [
//         "Eres el asistente de una clínica estética.",
//         "Tono humano, cálido y breve. Puedes iniciar con un saludo corto y natural (una sola línea) al inicio de la conversacion y no en inguna otra parte.",
//         "Usa como máximo un emoji natural (solo uno).",
//         "No des precios exactos; usa 'desde' si existe priceMin.",
//         "No infieras horas: si el cliente escribe la hora, repítela tal cual; no calcules ni conviertas.",
//         "Prohibido preguntar '¿te paso precios u horarios?'. En su lugar, si corresponde, pide solo el *día y hora* preferidos.",
//         "Si el usuario pregunta fuera de estética, reencausa al ámbito de servicios y agendamiento.",
//         "Si faltan datos operativos (pagos/promos/etc.), responde: 'esa información se confirma en la valoración o directamente en la clínica'.",
//         "Tu única fuente es el RESUMEN a continuación.",
//         "\n=== RESUMEN ===\n" + summary + "\n=== FIN ===",
//     ].join("\n");


//     const messages: any[] = [{ role: "system", content: sys }];
//     if (imageUrl) {
//         messages.push({
//             role: "user",
//             content: [
//                 { type: "text", text: userText },
//                 { type: "image_url", image_url: { url: imageUrl } },
//             ],
//         });
//     } else {
//         messages.push({ role: "user", content: userText });
//     }

//     const r = await openai.chat.completions.create({
//         model: CONF.MODEL,
//         messages,
//         temperature: CONF.TEMPERATURE,
//         max_tokens: 220,
//     });
//     return r?.choices?.[0]?.message?.content?.trim() || "";
// }

// /* ===== Núcleo (estrategia) ===== */
// export async function handleEsteticaStrategy({
//     chatId,
//     empresaId,
//     mensajeArg = "",
//     toPhone,
//     phoneNumberId,
// }: {
//     chatId: number;
//     empresaId: number;
//     mensajeArg?: string;
//     toPhone?: string;
//     phoneNumberId?: string;
// }) {
//     const conversacion = await prisma.conversation.findUnique({
//         where: { id: chatId },
//         select: { id: true, phone: true, estado: true },
//     });
//     if (!conversacion) return null;

//     // Guard si ya está bloqueado por handoff
//     const statePre = await loadState(chatId);
//     if (conversacion.estado === ConversationEstado.requiere_agente || statePre.handoffLocked) {
//         return { estado: "pendiente", mensaje: "" };
//     }

//     const last = await prisma.message.findFirst({
//         where: { conversationId: chatId, from: MessageFrom.client },
//         orderBy: { timestamp: "desc" },
//         select: {
//             id: true,
//             contenido: true,
//             mediaType: true,
//             mediaUrl: true,
//             caption: true,
//             mimeType: true,
//             isVoiceNote: true,
//             transcription: true,
//             timestamp: true,
//         },
//     });
//     if (last?.id && seenInboundRecently(last.id)) return null;
//     if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp)) return null;

//     let userText = (mensajeArg || "").trim();

//     // Voz → transcribir
//     if (!userText && isVoiceInbound(last || {})) {
//         let tr = last?.transcription?.trim() || "";
//         if (!tr && last?.mediaUrl) {
//             try {
//                 const { data } = await axios.get(last.mediaUrl, { responseType: "arraybuffer" });
//                 tr = await transcribeAudioBuffer(Buffer.from(data), "audio.ogg");
//                 if (tr)
//                     await prisma.message.update({ where: { id: last.id }, data: { transcription: tr } });
//             } catch { }
//         }
//         if (tr) userText = tr;
//     }
//     if (!userText) userText = last?.contenido?.trim() || "";

//     const kb = await loadEsteticaKB({ empresaId });
//     if (!kb) {
//         const msg = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: msg,
//             nuevoEstado: ConversationEstado.requiere_agente,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
//         await patchState(chatId, { handoffLocked: true });
//         return {
//             estado: ConversationEstado.requiere_agente,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }

//     const { url: imageUrl, noteToAppend } = await pickImageForContext({
//         conversationId: chatId,
//         userText,
//         caption: last?.caption || "",
//         referenceTs: last?.timestamp || new Date(),
//     });
//     if (noteToAppend) userText += noteToAppend;

//     // ====== Agendamiento flexible (colecta progresiva sin calcular hora) ======
//     // 1) Actualiza draft con lo que venga en texto
//     let state = await loadState(chatId);
//     let nameInText = extractName(userText);
//     // Fallback: si aún falta nombre y el usuario envía solo “Juan Camilo López”, tómalos como nombre.
//     if (!nameInText) {
//         const stateNow = await loadState(chatId);
//         const needNameNow = !(stateNow.draft?.name);
//         if (needNameNow) {
//             const loose = looksLikeLooseName(userText);
//             if (loose) nameInText = loose;
//         }
//     }

//     const whenFree = grabWhenFreeText(userText);
//     let match = resolveServiceName(kb, userText || "");
//     if (!match.procedure) {
//         // sinónimos mínimos
//         const t = (userText || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//         if (/\bbotox|toxina\b/.test(t)) {
//             const tox = kb.procedures.find((p) => /toxina\s*botul/i.test(p.name));
//             if (tox) match = { procedure: tox, matched: tox.name };
//         } else if (/\blimpieza\b/.test(t)) {
//             const limp = kb.procedures.find((p) => /limpieza/i.test(p.name));
//             if (limp) match = { procedure: limp, matched: limp.name };
//         } else if (/\bpeeling\b/.test(t)) {
//             const pe = kb.procedures.find((p) => /peeling/i.test(p.name));
//             if (pe) match = { procedure: pe, matched: pe.name };
//         }
//     }

//     const prevDraft = state.draft ?? {};
//     const newDraft = {
//         ...prevDraft,
//         name: prevDraft.name || nameInText || undefined,
//         procedureId: prevDraft.procedureId || (match.procedure?.id ?? undefined),
//         procedureName: prevDraft.procedureName || (match.procedure?.name ?? undefined),
//         // whenISO: opcional—solo si detectas una fecha explícita tipo 12/11; aquí no forzamos
//         whenISO: prevDraft.whenISO || undefined,
//         whenText: prevDraft.whenText || whenFree || undefined, // textual SIEMPRE
//     };
//     const inferredIntent = detectIntent(userText, newDraft);
//     await patchState(chatId, { draft: newDraft, lastIntent: inferredIntent });


//     // 2) Si el usuario ya trajo todo → handoff inmediato
//     // 2) Si el usuario ya trajo todo → handoff inmediato
//     if (detectHandoffReady(userText) || (newDraft.name && newDraft.procedureName && hasSomeDateDraft(newDraft))) {
//         // ——— Mensaje de handoff mejorado (premium) ———
//         const piezasBonitas = [
//             `💆 *Tratamiento:* ${newDraft.procedureName ?? "—"}`,
//             `👤 *Nombre:* ${newDraft.name}`,
//             newDraft.whenText
//                 ? `🗓️ *Preferencia:* ${newDraft.whenText}`
//                 : (newDraft.whenISO
//                     ? `🗓️ *Fecha:* ${new Date(newDraft.whenISO).toLocaleDateString("es-CO", {
//                         weekday: "long",
//                         day: "2-digit",
//                         month: "2-digit",
//                         year: "numeric",
//                     })}`
//                     : ""),
//         ].filter(Boolean).join("\n");

//         let cleaned = `Perfecto ✨, dame *unos minutos* mientras *verifico la disponibilidad* para ese horario y te confirmo por aquí.\n\n${piezasBonitas}`;

//         // Limpieza de saludos y duplicados
//         cleaned = sanitizeGreeting(cleaned);

//         // Evita que aparezca un “Mi nombre es ...” que el modelo pudiera meter en alguna vuelta
//         cleaned = cleaned.replace(/\bmi\s+nombre\s+es\s+[A-ZÁÉÍÓÚÑa-záéíóúñü\s]+/gi, "").trim();

//         // Un solo emoji premium y estable por conversación
//         cleaned = addEmojiStable(cleaned, chatId);

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: clampText(cleaned),
//             nuevoEstado: ConversationEstado.requiere_agente,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
//         await patchState(chatId, { handoffLocked: true });
//         return {
//             estado: ConversationEstado.requiere_agente,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }


//     // 3) Si está fuera de alcance → redirige suave
//     if (isOutOfScope(userText)) {
//         const txt =
//             "Puedo ayudarte con información de nuestros servicios estéticos y agendar tu cita. ¿Qué procedimiento te interesa o para qué fecha te gustaría programar? 🙂";

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto: txt,
//             nuevoEstado: ConversationEstado.respondido,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
//         return {
//             estado: ConversationEstado.respondido,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }
//     // ——— Respuesta directa a “qué servicios” (sin matar la conversación ni forzar agenda)
//     if (/\b(que\s+servicios|qué\s+servicios|servicios\s+ofreces?)\b/i.test(userText)) {
//         const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
//         const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
//         const items = (kb.procedures || []).slice(0, 6).map((p) => {
//             const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
//             return `• ${p.name}${desde}`;
//         }).join("\n");

//         let texto = clampText(
//             `${items}\n\nSi alguno te interesa, dime el *día y hora* que prefieres agendar${human ? ` (trabajamos: ${human}${sufijoUltima})` : ""}.`
//         );
//         texto = addEmojiStable(texto, chatId);

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto,
//             nuevoEstado: ConversationEstado.respondido,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
//         await patchState(chatId, { lastIntent: "schedule" });
//         return {
//             estado: ConversationEstado.respondido,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }


//     // ===== Summary extendido (cacheado y persistido en conversation_state)
//     const summary = await buildOrReuseSummary({ empresaId, conversationId: chatId, kb });

//     // ===== Si aún faltan piezas para agenda, pedimos solo lo que falta (sin forzar hora)
//     // ===== Pedir piezas SOLO si hay intención de agenda o ya hay piezas
//     const needProcedure = !newDraft.procedureId && !newDraft.procedureName;
//     const needWhen = !hasSomeDateDraft(newDraft);
//     const needName = !newDraft.name;

//     const hasServiceOrWhen = !!(newDraft.procedureId || newDraft.procedureName || newDraft.whenText || newDraft.whenISO);
//     const infoBreaker = shouldBypassScheduling(userText);

//     const shouldAskForAgendaPieces =
//         !infoBreaker && (state.lastIntent === "schedule" || inferredIntent === "schedule" || hasServiceOrWhen);

//     if (shouldAskForAgendaPieces && (needProcedure || needWhen || needName)) {

//         const asks: string[] = [];
//         if (needProcedure) {
//             const sample = kb.procedures.slice(0, 3).map(s => s.name).join(", ");
//             asks.push(`¿Para qué *tratamiento* deseas la cita? (Ej.: ${sample})`);
//         }
//         if (needWhen) {
//             asks.push(`¿Qué *día y hora* prefieres? Escríbelo *tal cual* (ej.: “martes en la tarde” o “15/11 a las 3 pm”).`);
//         }
//         if (needName) {
//             asks.push(`¿Cuál es tu *nombre completo*?`);
//         }
//         let texto = clampText(asks.join(" "));
//         texto = addEmojiStable(texto, chatId);

//         const saved = await persistBotReply({
//             conversationId: chatId,
//             empresaId,
//             texto,
//             nuevoEstado: ConversationEstado.respondido,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
//         return {
//             estado: ConversationEstado.respondido,
//             mensaje: saved.texto,
//             messageId: saved.messageId,
//             wamid: saved.wamid,
//             media: [],
//         };
//     }


//     // ===== Respuesta libre (modo natural) usando el summary extendido
//     let texto = await runLLM({ summary, userText, imageUrl }).catch(() => "");
//     texto = sanitizeGreeting(texto);           // ← NUEVO
//     texto = clampText(texto || "¡Hola! ¿Prefieres info de tratamientos o ver opciones para agendar?");
//     texto = addEmojiStable(texto, chatId);


//     const saved = await persistBotReply({
//         conversationId: chatId,
//         empresaId,
//         texto,
//         nuevoEstado: ConversationEstado.respondido,
//         to: toPhone ?? conversacion.phone,
//         phoneNumberId,
//     });

//     if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);

//     return {
//         estado: ConversationEstado.respondido,
//         mensaje: saved.texto,
//         messageId: saved.messageId,
//         wamid: saved.wamid,
//         media: [],
//     };
// }

// /* ===== WRAPPER COMPATIBLE CON EL ORQUESTADOR ===== */
// export async function handleEsteticaReply(args: {
//     chatId?: number;
//     conversationId?: number;
//     empresaId: number;
//     contenido?: string;
//     toPhone?: string;
//     phoneNumberId?: string;
// }): Promise<{
//     estado: "pendiente" | "respondido" | "en_proceso" | "requiere_agente";
//     mensaje: string;
//     messageId?: number;
//     wamid?: string;
//     media?: any[];
// }> {
//     const {
//         chatId,
//         conversationId: conversationIdArg,
//         empresaId,
//         contenido,
//         toPhone,
//         phoneNumberId,
//     } = args;

//     const conversationId = conversationIdArg ?? chatId;
//     if (!conversationId) return { estado: "pendiente", mensaje: "" };

//     const res = await handleEsteticaStrategy({
//         chatId: conversationId,
//         empresaId,
//         mensajeArg: (contenido || "").trim(),
//         toPhone,
//         phoneNumberId,
//     });

//     if (!res) return { estado: "pendiente", mensaje: "" };

//     return {
//         estado: (res.estado as any) || ConversationEstado.respondido,
//         mensaje: res.mensaje || "",
//         messageId: res.messageId,
//         wamid: res.wamid,
//         media: res.media || [],
//     };
// }




// utils/ai/strategies/estetica.strategy.ts
import axios from "axios";
import prisma from "../../../lib/prisma";
import {
    ConversationEstado,
    MediaType,
    MessageFrom,
} from "@prisma/client";
import { openai } from "../../../lib/openai";
import * as Wam from "../../../services/whatsapp.service";
import { transcribeAudioBuffer } from "../../../services/transcription.service";
import {
    loadEsteticaKB,
    resolveServiceName,
    type EsteticaKB,
} from "./esteticaModules/domain/estetica.kb";

/* ==== CONFIG ==== */
const CONF = {
    MEM_TTL_MIN: 60,
    GRAN_MIN: 15,
    MAX_HISTORY: 20,
    REPLY_MAX_LINES: 5,
    REPLY_MAX_CHARS: 900,
    TEMPERATURE: 0.3,
    MODEL: process.env.IA_TEXT_MODEL || "gpt-4o-mini",
};

const IMAGE_WAIT_MS = 1000;
const IMAGE_CARRY_MS = 60_000;
const IMAGE_LOOKBACK_MS = 300_000;
const REPLY_DEDUP_WINDOW_MS = 120_000;

/* ===== UTILS ===== */
function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
const processedInbound = new Map<number, number>();
function seenInboundRecently(mid: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
    const now = Date.now();
    const prev = processedInbound.get(mid);
    if (prev && now - prev <= windowMs) return true;
    processedInbound.set(mid, now);
    return false;
}

/** Conversational dedup (double-reply window per conversation) */
const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = 120_000) {
    const now = Date.now();
    const prev = recentReplies.get(conversationId);
    if (prev && prev.afterMs >= clientTs.getTime() && now - prev.repliedAtMs <= windowMs) return true;
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
    return false;
}
function markActuallyReplied(conversationId: number, clientTs: Date) {
    recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: Date.now() });
}

/** Detecta si el mensaje es nota de voz o audio */
function isVoiceInbound(last: { isVoiceNote?: boolean | null; mediaType?: any; mimeType?: string | null; }) {
    if (last?.isVoiceNote) return true;
    const mt = String(last?.mediaType ?? "").toLowerCase();
    if (mt === "audio" || mt === "voice") return true;
    return (last?.mimeType || "").startsWith("audio/");
}

/** Busca imagen contextual */
async function pickImageForContext({
    conversationId,
    userText,
    caption,
    referenceTs,
}: {
    conversationId: number;
    userText: string;
    caption: string;
    referenceTs: Date;
}) {
    const s = userText.toLowerCase();
    const mentionsImg =
        /\b(foto|imagen|selfie|captura)\b/.test(s) ||
        /(mira|env[ií]e)\s+(la\s+)?(foto|imagen)/.test(s);

    const recent = await prisma.message.findFirst({
        where: {
            conversationId,
            from: MessageFrom.client,
            mediaType: MediaType.image,
            timestamp: {
                gte: new Date(referenceTs.getTime() - (mentionsImg ? IMAGE_LOOKBACK_MS : IMAGE_CARRY_MS)),
                lte: referenceTs,
            },
        },
        orderBy: { timestamp: "desc" },
        select: { mediaUrl: true, caption: true },
    });

    if (recent?.mediaUrl) {
        const note = recent.caption ? `\n\nNota de la imagen: ${recent.caption}` : "";
        return { url: recent.mediaUrl, noteToAppend: note };
    }
    return { url: null, noteToAppend: "" };
}

/* ======= STATE (conversation_state) ======= */
type AgentState = {
    greeted?: boolean;
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    draft?: {
        name?: string;
        phone?: string;
        procedureId?: number;
        procedureName?: string;
        whenISO?: string;
        whenText?: string; // fecha/hora “tal cual” que escribió el cliente (sin calcular)
        // NOTA: no usamos timeHHMM ni timeNote para no “inferir” horas
    };
    summary?: { text: string; expiresAt: string };
    expireAt?: string;
    handoffLocked?: boolean;
};
function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}
async function loadState(conversationId: number): Promise<AgentState> {
    const row = await prisma.conversationState.findUnique({
        where: { conversationId },
        select: { data: true },
    });
    const raw = (row?.data as any) || {};
    const data: AgentState = {
        greeted: !!raw.greeted,
        lastIntent: raw.lastIntent,
        lastServiceId: raw.lastServiceId ?? null,
        lastServiceName: raw.lastServiceName ?? null,
        draft: raw.draft ?? {},
        summary: raw.summary ?? undefined,
        expireAt: raw.expireAt,
        handoffLocked: !!raw.handoffLocked,
    };
    const expired = data.expireAt ? Date.now() > Date.parse(data.expireAt) : true;
    if (expired) return { greeted: data.greeted, handoffLocked: data.handoffLocked, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    return data;
}
async function saveState(conversationId: number, data: AgentState) {
    const next: AgentState = { ...data, expireAt: nowPlusMin(CONF.MEM_TTL_MIN) };
    await prisma.conversationState.upsert({
        where: { conversationId },
        create: { conversationId, data: next as any },
        update: { data: next as any },
    });
}
async function patchState(conversationId: number, patch: Partial<AgentState>) {
    const prev = await loadState(conversationId);
    await saveState(conversationId, { ...prev, ...patch });
}

/* ===== Helpers para agenda (DB) ===== */
function pad2(n: number) { return String(n).padStart(2, "0"); }
function hhmmFrom(raw?: string | null) {
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    const hh = Math.min(23, Number(m[1] ?? 0));
    const mm = Math.min(59, Number(m[2] ?? 0));
    return `${pad2(hh)}:${pad2(mm)}`;
}
function weekdayToDow(day: any): number | null {
    const key = String(day || "").toUpperCase();
    const map: Record<string, number> = {
        SUNDAY: 0, DOMINGO: 0,
        MONDAY: 1, LUNES: 1,
        TUESDAY: 2, MARTES: 2,
        WEDNESDAY: 3, MIERCOLES: 3, MIÉRCOLES: 3,
        THURSDAY: 4, JUEVES: 4,
        FRIDAY: 5, VIERNES: 5,
        SATURDAY: 6, SABADO: 6, SÁBADO: 6,
    };
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}
async function fetchAppointmentHours(empresaId: number) {
    const rows = await prisma.appointmentHour.findMany({
        where: { empresaId },
        orderBy: [{ day: "asc" }],
        select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    return rows;
}
async function fetchAppointmentExceptions(empresaId: number, horizonDays = 35) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + horizonDays);
    try {
        const rows: any[] = await (prisma as any).appointment_exeption.findMany({
            where: { empresaId, date: { gte: now, lte: end } },
            orderBy: [{ date: "asc" }],
            select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
        });
        return rows;
    } catch {
        try {
            const rows: any[] = await (prisma as any).appointment_exception.findMany({
                where: { empresaId, date: { gte: now, lte: end } },
                orderBy: [{ date: "asc" }],
                select: { date: true, dateISO: true, isOpen: true, open: true, closed: true, motivo: true, reason: true, tz: true },
            });
            return rows;
        } catch {
            return [];
        }
    }
}
function normalizeHours(rows: any[]) {
    const byDow: Record<number, Array<{ start: string; end: string }>> = {};
    for (const r of rows || []) {
        if (!r) continue;
        if (r.isOpen === false) continue;
        const dow = weekdayToDow(r.day);
        if (dow == null) continue;
        const s1 = hhmmFrom(r.start1), e1 = hhmmFrom(r.end1);
        const s2 = hhmmFrom(r.start2), e2 = hhmmFrom(r.end2);
        if (s1 && e1) (byDow[dow] ||= []).push({ start: s1, end: e1 });
        if (s2 && e2) (byDow[dow] ||= []).push({ start: s2, end: e2 });
    }
    return byDow;
}
function normalizeExceptions(rows: any[]) {
    const items: Array<{ date: string; closed: boolean; motivo?: string }> = [];
    for (const r of rows || []) {
        const closed = (r.isOpen === false) || (r.closed === true) || (r.open === false);
        const date = r.dateISO ?? (r.date ? new Date(r.date).toISOString().slice(0, 10) : null);
        if (!date) continue;
        items.push({ date, closed, motivo: r.motivo ?? r.reason });
    }
    return items;
}

/* ===== INTENT DETECTOR (no forzar agenda) ===== */

/* ==== INFO / SCHEDULE GUARDS (del componente viejo) ==== */
function isSchedulingCue(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(agendar|agenda|reservar|programar)\b/.test(s) ||
        /quieres ver horarios|te paso horarios|dime el dia y hora|que dia y hora prefieres/.test(s)
    );
}

function isShortQuestion(t: string): boolean {
    const s = (t || "").trim();
    const noSpaces = s.replace(/\s+/g, "");
    const hasQM = /[?¿]/.test(s);
    return hasQM && s.length <= 120 && noSpaces.length >= 2;
}

function containsDateOrTimeHints(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(hoy|manana|mañana|proxima|semana|lunes|martes|miercoles|jueves|viernes|sabado|sábado|domingo|am|pm|a las|hora|tarde|noche|mediodia|medio dia)\b/.test(s) ||
        /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(s) ||
        /\b(\d{1,2}:\d{2})\b/.test(s)
    );
}

function isPaymentQuestion(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return /\b(pagos?|metodos? de pago|tarjeta|efectivo|transferencia|nequi|daviplata|pse)\b/.test(s);
}

function isGeneralInfoQuestion(t: string): boolean {
    const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return (
        /\b(que es|de que se trata|como funciona|beneficios?|riesgos?|efectos secundarios?|contraindicaciones?|cuidados|cuanto dura|duracion|quien lo hace|profesional|doctor(a)?)\b/.test(s) ||
        /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|sede|como llego|parqueadero)\b/.test(s) ||
        isPaymentQuestion(t)
    );
}

function isEducationalQuestion(text: string): boolean {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (/\b(que es|de que se trata|como funciona|como actua|beneficios?|riesgos?|efectos secundarios?|cuidados|contraindicaciones?)\b/.test(t)) return true;
    if (/\b(b[óo]tox|toxina|acido hialuronico|peeling|manchas|acne|rosacea|melasma|flacidez)\b/.test(t)) return true;
    if (/\b(recomendable|sirve|me ayuda)\b/.test(t) && /\b(rosacea|acne|melasma|cicatriz|flacidez|arrugas|manchas)\b/.test(t)) return true;
    return false;
}

function shouldBypassScheduling(t: string): boolean {
    if (isSchedulingCue(t) || containsDateOrTimeHints(t)) return false; // señales claras → sí agenda
    if (isShortQuestion(t) || isGeneralInfoQuestion(t) || isEducationalQuestion(t)) return true; // informativo → NO agenda
    return false;
}


type Intent = "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";

function detectIntent(text: string, draft: AgentState["draft"]): Intent {
    const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

    // señales de agenda explícita
    const scheduleHints = [
        "agendar", "agendo", "agendemos", "agenda", "cita", "programar", "reservar", "reserva",
        "disponible", "disponibilidad", "horario", "hora", "dia", "fecha", "cuando atienden", "para el",
        "quiero ir", "puedo ir", "mañana", "manana", "tarde", "noche", "am", "pm", "a las"
    ];
    if (scheduleHints.some(h => t.includes(h))) return "schedule";


    // Si ya trajo alguna pieza REAL de agenda (servicio o fecha/hora), seguimos en schedule
    if (draft?.procedureId || draft?.procedureName || draft?.whenText || draft?.whenISO) return "schedule";


    // precio/costo
    if (/\b(precio|precios|costo|vale|cuanto|desde)\b/.test(t)) return "price";

    // reprogramación / cancelación
    if (/\b(reprogram|cambiar|mover)\b/.test(t)) return "reschedule";
    if (/\b(cancelar|anular)\b/.test(t)) return "cancel";

    // preguntas tipo “¿qué es?”, “¿cómo funciona?”
    if (/\b(que es|como funciona|efectos|riesgos|duracion|contraindicaciones|recomendaciones)\b/.test(t)) return "info";

    // saludo/otros → libre
    return "other";
}


/* ===== Summary extendido con cache en conversation_state ===== */
function softTrim(s: string | null | undefined, max = 240) {
    const t = (s || "").trim();
    if (!t) return "";
    return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
}
function formatCOP(value?: number | null): string | null {
    if (value == null || isNaN(Number(value))) return null;
    return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
}
async function buildBusinessRangesHuman(
    empresaId: number,
    kb: EsteticaKB,
    opts?: { defaultDurMin?: number; rows?: any[] }
): Promise<{ human: string; lastStart?: string }> {
    const rows = opts?.rows ?? await fetchAppointmentHours(empresaId);
    const byDow = normalizeHours(rows);
    const dayShort = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

    const parts: string[] = [];
    for (let d = 0; d < 7; d++) {
        const ranges = byDow[d];
        if (ranges?.length) parts.push(`${dayShort[d]} ${ranges.map(r => `${r.start}–${r.end}`).join(", ")}`);
    }
    const human = parts.join("; ");

    const dur = Math.max(30, opts?.defaultDurMin ?? (kb.defaultServiceDurationMin ?? 60));
    const weekdays = [1, 2, 3, 4, 5];
    const endsWeekdays: string[] = [];
    const endsAll: string[] = [];

    for (const d of weekdays) for (const r of (byDow[d] || [])) if (r.end) endsWeekdays.push(r.end);
    for (let d = 0; d < 7; d++) for (const r of (byDow[d] || [])) if (r.end) endsAll.push(r.end);
    const pool = endsWeekdays.length ? endsWeekdays : endsAll;
    if (!pool.length) return { human, lastStart: undefined };

    const maxEnd = pool.sort()[pool.length - 1];
    const [eh, em] = maxEnd.split(":").map(Number);
    const startMins = eh * 60 + em - dur;
    const sh = Math.max(0, Math.floor(startMins / 60));
    const sm = Math.max(0, startMins % 60);
    const lastStart = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;

    return { human, lastStart };
}
function paymentMethodsFromKB(kb: EsteticaKB): string[] {
    const list: string[] = [];
    const pm: any = (kb as any).paymentMethods ?? (kb as any).payments ?? [];
    if (Array.isArray(pm)) {
        for (const it of pm) {
            if (!it) continue;
            if (typeof it === "string") list.push(it);
            else if (typeof it?.name === "string") list.push(it.name);
        }
    }
    const flags: Array<[string, any]> = [
        ["Efectivo", (kb as any).cash],
        ["Tarjeta débito/crédito", (kb as any).card || (kb as any).cards],
        ["Transferencia", (kb as any).transfer || (kb as any).wire],
        ["PSE", (kb as any).pse],
        ["Nequi", (kb as any).nequi],
        ["Daviplata", (kb as any).daviplata],
    ];
    for (const [label, v] of flags) if (v === true) list.push(label);
    return Array.from(new Set(list)).sort();
}

async function buildOrReuseSummary(args: {
    empresaId: number;
    conversationId: number;
    kb: EsteticaKB;
}): Promise<string> {
    const { empresaId, conversationId, kb } = args;

    const cached = await loadState(conversationId);
    const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
    if (fresh) return cached.summary!.text;

    const [hoursRows, exceptionsRows, apptCfg] = await Promise.all([
        fetchAppointmentHours(empresaId),
        fetchAppointmentExceptions(empresaId, 35),
        prisma.businessConfigAppt.findUnique({
            where: { empresaId },
            select: {
                appointmentEnabled: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentMinNoticeHours: true,
                appointmentMaxAdvanceDays: true,
                allowSameDayBooking: true,
                defaultServiceDurationMin: true,
                appointmentPolicies: true,
                locationName: true,
                locationAddress: true,
                locationMapsUrl: true,
                parkingInfo: true,
                instructionsArrival: true,
                noShowPolicy: true,
                depositRequired: true,
                depositAmount: true,
                servicesText: true,
                services: true,
                kbBusinessOverview: true,
                kbFAQs: true,
                kbServiceNotes: true,
                kbEscalationRules: true,
                kbDisclaimers: true,
                kbMedia: true,
                kbFreeText: true,
            },
        }),
    ]);

    const { human: hoursLine, lastStart } = await buildBusinessRangesHuman(empresaId, kb, { rows: hoursRows });
    const exceptions = normalizeExceptions(exceptionsRows);
    const exLine = exceptions.filter(e => e.closed).slice(0, 10).map(e => e.date).join(", ");
    const exceptionsLine = exLine ? `Excepciones (cerrado): ${exLine}` : "";

    const svcFromKB = (kb.procedures ?? [])
        .filter(s => s.enabled !== false)
        .map(s => (s.priceMin ? `${s.name} (Desde ${formatCOP(s.priceMin)})` : s.name))
        .join(" • ");

    const payments = paymentMethodsFromKB(kb);
    const paymentsLine = payments.length ? `Pagos: ${payments.join(" • ")}` : "";

    const msgs = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: "desc" },
        take: 10,
        select: { from: true, contenido: true },
    });
    const history = msgs
        .reverse()
        .map((m) => `${m.from === MessageFrom.client ? "U" : "A"}: ${softTrim(m.contenido || "", 100)}`)
        .join(" | ");

    const S = apptCfg || ({} as any);

    // ==== Normalizar FAQs =====
    type FAQ = { q: string; a: string };

    function parseMaybeJson<T = any>(val: any): T | any {
        if (typeof val === "string") {
            try { return JSON.parse(val); } catch { /* noop */ }
        }
        return val;
    }

    function toFaqArray(src: any): FAQ[] {
        const v = parseMaybeJson(src);
        if (!v) return [];

        if (Array.isArray(v)) {
            if (v.length && typeof v[0] === "string") {
                return v.map((s: string) => {
                    const [q, a] = String(s).split("|");
                    return { q: (q || "").trim(), a: (a || "").trim() };
                }).filter(f => f.q && f.a);
            }
            if (v.length && typeof v[0] === "object") {
                return v.map((o: any) => ({
                    q: String(o?.q || "").trim(),
                    a: String(o?.a || "").trim(),
                })).filter(f => f.q && f.a);
            }
        }

        if (typeof v === "object") {
            return Object.entries(v).map(([q, a]) => ({
                q: String(q).trim(),
                a: String(a ?? "").trim(),
            })).filter(f => f.q && f.a);
        }

        if (typeof v === "string") {
            return v.split(/\r?\n/).map(l => {
                const [q, a] = l.split("|");
                return { q: (q || "").trim(), a: (a || "").trim() };
            }).filter(f => f.q && f.a);
        }

        return [];
    }

    const faqsFromCfg = toFaqArray(S.kbFAQs);
    const faqsFromKB1 = toFaqArray((kb as any).kbFAQs);
    const faqsFromKB2 = toFaqArray((kb as any).faqs);

    const seen = new Set<string>();
    const faqsArr = [...faqsFromCfg, ...faqsFromKB1, ...faqsFromKB2]
        .filter(f => f && f.q && f.a)
        .filter(f => {
            const k = f.q.trim().toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

    console.log("FAQs sizes =>", {
        cfg: faqsFromCfg.length,
        kb1: faqsFromKB1.length,
        kb2: faqsFromKB2.length,
        merged: faqsArr.length,
    });

    const faqsLine = faqsArr.length
        ? "FAQs: " +
        faqsArr
            .slice(0, 5)
            .map(f => `${softTrim(f.q, 60)} → ${softTrim(f.a, 120)}`)
            .join(" | ")
        : "";

    function icon(label: "biz" | "tz" | "agenda" | "rules" | "log" | "pol" | "pay" | "svc" | "hrs" | "exc" | "faq" | "note" | "hist") {
        const map = {
            biz: "🏥", tz: "🌐", agenda: "⏰", rules: "📋", log: "📍", pol: "🧾",
            pay: "💳", svc: "✨", hrs: "🕒", exc: "🚫", faq: "💬", note: "📝", hist: "🧠"
        } as const;
        return map[label];
    }

    const lines: string[] = [];
    lines.push(`${icon("biz")} *${kb.businessName || "Clínica estética"}*`);
    lines.push(`${icon("tz")} Zona horaria: ${S.appointmentTimezone || kb.timezone}`);

    const rulesArr = [
        S.appointmentEnabled != null ? `Agenda: ${S.appointmentEnabled ? "habilitada" : "deshabilitada"}` : "",
        (S.appointmentBufferMin ?? kb.bufferMin) != null ? `Buffer: ${S.appointmentBufferMin ?? kb.bufferMin} min` : "",
        S.allowSameDayBooking != null ? `Mismo día: ${S.allowSameDayBooking ? "sí" : "no"}` : "",
        S.appointmentMinNoticeHours != null ? `Anticipación: ${S.appointmentMinNoticeHours} h` : "",
        S.appointmentMaxAdvanceDays != null ? `Hasta: ${S.appointmentMaxAdvanceDays} días` : "",
    ].filter(Boolean);
    if (rulesArr.length) lines.push(`${icon("rules")} ${rulesArr.join(" · ")}`);

    const logArr = [
        S.locationName ? `Sede: ${S.locationName}` : "",
        S.locationAddress ? `Dir: ${S.locationAddress}` : "",
        S.locationMapsUrl ? `Mapa: ${S.locationMapsUrl}` : "",
        S.parkingInfo ? `Parqueadero: ${softTrim(S.parkingInfo, 120)}` : "",
        S.instructionsArrival ? `Ingreso: ${softTrim(S.instructionsArrival, 120)}` : "",
    ].filter(Boolean);
    if (logArr.length) lines.push(`${icon("log")} ${logArr.join(" · ")}`);

    if (S.noShowPolicy || S.depositRequired != null) {
        const pols = [
            S.noShowPolicy ? `No-show: ${softTrim(S.noShowPolicy, 120)}` : "",
            S.depositRequired ? `Depósito: ${S.depositAmount ? formatCOP(Number(S.depositAmount)) : "sí"}` : "Depósito: no",
        ].filter(Boolean);
        lines.push(`${icon("pol")} ${pols.join(" · ")}`);
    }

    if (payments.length) lines.push(`${icon("pay")} Pagos: ${payments.join(" • ")}`);

    const svcList = (kb.procedures ?? [])
        .filter(s => s.enabled !== false)
        .slice(0, 6)
        .map(s => s.priceMin ? `${s.name} (desde ${formatCOP(s.priceMin)})` : s.name)
        .join(" • ");
    if (svcList) lines.push(`${icon("svc")} Servicios: ${svcList}`);

    if (hoursLine) lines.push(`${icon("hrs")} Horario: ${hoursLine}${lastStart ? `; última cita ref. ${lastStart}` : ""}`);
    if (exceptionsLine) lines.push(`${icon("exc")} ${exceptionsLine}`);

    if (faqsArr.length) {
        lines.push(`${icon("faq")} *FAQs rápidas*`);
        for (const f of faqsArr.slice(0, 5)) {
            lines.push(`• ${softTrim(f.q, 60)} → ${softTrim(f.a, 140)}`);
        }
    }

    if (S.kbBusinessOverview) lines.push(`${icon("note")} ${softTrim(S.kbBusinessOverview, 260)}`);
    if (S.kbFreeText) lines.push(`${icon("note")} ${softTrim(S.kbFreeText, 260)}`);

    lines.push(`${icon("hist")} Historial: ${history || "—"}`);

    let compact = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    compact = softTrim(compact, 1000);

    await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
    return compact;
}

/* ===== Detección de handoff listo (nombre + fecha/hora textual + procedimiento) ===== */
function detectHandoffReady(t: string) {
    const text = (t || "").toLowerCase();

    const hasName =
        /\bmi\s+nombre\s+es\s+[a-záéíóúñü\s]{3,}/i.test(t) ||
        /\bsoy\s+[a-záéíóúñü\s]{3,}/i.test(t);

    const hasDateOrTimeText =
        /\b(hoy|mañana|manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|am|pm|tarde|mañana|manana|noche|mediod[ií]a|medio\s+dia)\b/.test(text) ||
        /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(text) ||
        /\b(\d{1,2}[:.]\d{2}\s*(am|pm)?)\b/.test(text);

    const hasProc =
        /\b(botox|toxina|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|laser|plasma|hilos|armonizaci[oó]n|mesoterapia)\b/.test(
            text
        );

    return hasName && hasDateOrTimeText && hasProc;
}

/* ===== Extractores suaves para el borrador (sin normalizar hora) ===== */
function normalizeName(n: string) {
    return n
        .trim()
        .replace(/\s+/g, " ")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
}

function extractName(raw: string): string | null {
    const t = (raw || "").trim();

    // Patrones explícitos
    let m =
        t.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,3})\b/i) ||
        t.match(/^\s*nombre\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,3})\s*$/i);

    if (m && m[1]) {
        const name = normalizeName(m[1]);
        if (/\b(viernes|sábado|sabado|lunes|martes|miércoles|miercoles|jueves|hoy|mañana|manana)\b/i.test(name)) return null;
        if (/\b(botox|toxina|peeling|limpieza|relleno|hialuronico|hialurónico)\b/i.test(name)) return null;
        return name;
    }
    return null;
}
function looksLikeLooseName(raw: string): string | null {
    const t = (raw || "").trim();

    if (/[0-9@#]/.test(t)) return null;

    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) return null;

    const bad = /\b(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|hoy|mañana|manana|tarde|noche|am|pm|a las|botox|toxina|peeling|limpieza|relleno|hialuronico|hialurónico)\b/i;
    if (bad.test(t.toLowerCase())) return null;

    if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñü\s]+$/.test(t)) return null;

    const normalized = t
        .replace(/\s+/g, " ")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");

    return normalized;
}

function grabWhenFreeText(raw: string): string | null {
    const t = (raw || "").toLowerCase();
    const hints = [
        "hoy", "mañana", "manana", "próxima", "proxima", "semana", "mes", "mediodia", "medio dia",
        "lunes", "martes", "miércoles", "miercoles", "jueves", "viernes", "sábado", "sabado",
        "am", "pm", "a las", "hora", "tarde", "noche", "domingo"
    ];
    const looksLikeDate = /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/.test(t);
    const hasHint = hints.some(h => t.includes(h));
    return (looksLikeDate || hasHint) ? softTrim(raw, 120) : null;
}
function hasSomeDateDraft(d?: AgentState["draft"]) {
    return !!(d?.whenISO || d?.whenText);
}
function sanitizeGreeting(text: string) {
    // Quita signos iniciales y espacios antes del saludo
    let s = (text || "").replace(/^[\s¡!¿?'"()\-–—]+/g, "").trim();

    // Saludos típicos al inicio, con o sin signos
    const patterns = [
        /^(?:hola|holi|hey|buen(?:os|as)?\s+(?:d[ií]as|tardes|noches)|qué tal|que tal|hola hola)[\s,.:;!¡¿?–—-]*/i,
    ];
    for (const rx of patterns) s = s.replace(rx, "").trim();

    // Si todavía arranca con un segundo “¡Hola!” (ej. LLM), intenta de nuevo
    s = s.replace(/^(?:¡\s*)?hola[!\s,.:;¡¿?–—-]*/i, "").trim();

    return s || text;
}

function prependFirstGreeting(text: string, greeted?: boolean, conversationId?: number) {
    if (greeted) return text;
    const base = "¡Hola! ¿En qué puedo ayudarte?";
    const withEmoji = addEmojiStable(base, conversationId ?? 0);
    const clean = sanitizeGreeting(text || "");
    return `${withEmoji}\n${clean}`.trim();
}

/* ===== FORMATO / RESPUESTA ===== */
function clampText(t: string, lines = CONF.REPLY_MAX_LINES, chars = CONF.REPLY_MAX_CHARS) {
    let txt = (t || "").trim();
    if (!txt) return txt;
    const arr = txt.split("\n").filter(Boolean);
    if (arr.length > lines) txt = arr.slice(0, lines).join("\n");
    if (txt.length > chars) txt = txt.slice(0, chars - 3) + "…";
    return txt;
}

/** Normaliza texto para deduplicación (insensible a mayúsculas, tildes y espacios) */
function normalizeForDedup(s: string) {
    return (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")     // quita tildes
        .replace(/[\s\n\r]+/g, " ")         // colapsa espacios
        .replace(/[^\p{L}\p{N}\s]/gu, "")   // quita signos/emoji para comparar
        .trim();
}

/** Un solo emoji “premium” por conversación (estable) */
function addEmojiStable(text: string, conversationId: number) {
    const base = (Number.isFinite(conversationId) ? conversationId : 0) >>> 0;
    const emojis = ["✨", "👌", "🙂", "🫶", "💬"];
    const idx = base % emojis.length;
    if (/[✨👌🙂🫶💬]/.test(text)) return text;
    return `${text} ${emojis[idx]}`;
}

/* ===== PERSISTENCIA ===== */
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
}: any) {
    // dedup suave con el último del bot:
    const prevBot = await prisma.message.findFirst({
        where: { conversationId, from: MessageFrom.bot },
        orderBy: { timestamp: "desc" },
        select: { id: true, contenido: true, timestamp: true, externalId: true },
    });
    if (prevBot) {
        const sameText =
            normalizeForDedup(prevBot.contenido || "") === normalizeForDedup(texto || "");
        const recent = Date.now() - new Date(prevBot.timestamp as any).getTime() <= 15_000;
        if (sameText && recent) {
            await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
            return { messageId: prevBot.id, texto: prevBot.contenido, wamid: prevBot.externalId as any, estado: nuevoEstado };
        }
    }

    const msg = await prisma.message.create({
        data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId },
    });
    await prisma.conversation.update({
        where: { id: conversationId },
        data: { estado: nuevoEstado },
    });
    let wamid: string | undefined;
    if (to) {
        try {
            const r = await Wam.sendWhatsappMessage({
                empresaId,
                to: normalizeToE164(to),
                body: texto,
                phoneNumberIdHint: phoneNumberId,
            });
            wamid = r?.data?.messages?.[0]?.id;
            if (wamid)
                await prisma.message.update({
                    where: { id: msg.id },
                    data: { externalId: wamid },
                });
        } catch { }
    }
    return { texto, wamid, messageId: msg.id };
}

/** ===== Saludo automático SOLO una vez (wrapper) ===== */
async function sendBotReply({
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
    const st = await loadState(conversationId);
    const withGreetingOnce = prependFirstGreeting(texto, st.greeted, conversationId);
    const saved = await persistBotReply({
        conversationId,
        empresaId,
        texto: withGreetingOnce,
        nuevoEstado,
        to,
        phoneNumberId,
    });
    if (!st.greeted) {
        await patchState(conversationId, { greeted: true });
    }
    return saved;
}

/* ===== OOT (fuera de alcance) ===== */
function isOutOfScope(text: string) {
    const t = (text || "").toLowerCase();
    const allowed =
        /(est[eé]tica|cl[ií]nica|botox|relleno|hialur[oó]nico|peeling|hidra|limpieza|depilaci[oó]n|l[aá]ser|plasma|hilos|armonizaci[oó]n|mesoterapia|facial|corporal|agenda|cita|precio|valoraci[oó]n)/i;
    const disallowed =
        /(finanzas|banco|cript|programaci[oó]n|servidor|vercel|render|pol[ií]tica|relig|tarea de colegio|matem[aá]ticas|qu[ií]mica|f[úu]tbol|tr[aá]mite|veh[ií]culo)/i;
    return !allowed.test(t) && disallowed.test(t);
}

/* ===== LLM ===== */
async function runLLM({ summary, userText, imageUrl }: any) {
    const sys = [
        "Eres el asistente de una clínica estética.",
        "Tono humano, cálido y breve. Puedes iniciar con un saludo corto y natural (una sola línea) al inicio de la conversacion y no en inguna otra parte.",
        "Usa como máximo un emoji natural (solo uno).",
        "No des precios exactos; usa 'desde' si existe priceMin.",
        "No infieras horas: si el cliente escribe la hora, repítela tal cual; no calcules ni conviertas.",
        "Prohibido preguntar '¿te paso precios u horarios?'. En su lugar, si corresponde, pide solo el *día y hora* preferidos.",
        "Si el usuario pregunta fuera de estética, reencausa al ámbito de servicios y agendamiento.",
        "Si faltan datos operativos (pagos/promos/etc.), responde: 'esa información se confirma en la valoración o directamente en la clínica'.",
        "Tu única fuente es el RESUMEN a continuación.",
        "\n=== RESUMEN ===\n" + summary + "\n=== FIN ===",
    ].join("\n");

    const messages: any[] = [{ role: "system", content: sys }];
    if (imageUrl) {
        messages.push({
            role: "user",
            content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: imageUrl } },
            ],
        });
    } else {
        messages.push({ role: "user", content: userText });
    }

    const r = await openai.chat.completions.create({
        model: CONF.MODEL,
        messages,
        temperature: CONF.TEMPERATURE,
        max_tokens: 220,
    });
    return r?.choices?.[0]?.message?.content?.trim() || "";
}

/* ===== Núcleo (estrategia) ===== */
export async function handleEsteticaStrategy({
    chatId,
    empresaId,
    mensajeArg = "",
    toPhone,
    phoneNumberId,
}: {
    chatId: number;
    empresaId: number;
    mensajeArg?: string;
    toPhone?: string;
    phoneNumberId?: string;
}) {
    const conversacion = await prisma.conversation.findUnique({
        where: { id: chatId },
        select: { id: true, phone: true, estado: true },
    });
    if (!conversacion) return null;

    // Guard si ya está bloqueado por handoff
    const statePre = await loadState(chatId);
    if (conversacion.estado === ConversationEstado.requiere_agente || statePre.handoffLocked) {
        return { estado: "pendiente", mensaje: "" };
    }

    const last = await prisma.message.findFirst({
        where: { conversationId: chatId, from: MessageFrom.client },
        orderBy: { timestamp: "desc" },
        select: {
            id: true,
            contenido: true,
            mediaType: true,
            mediaUrl: true,
            caption: true,
            mimeType: true,
            isVoiceNote: true,
            transcription: true,
            timestamp: true,
        },
    });
    if (last?.id && seenInboundRecently(last.id)) return null;
    if (last?.timestamp && shouldSkipDoubleReply(chatId, last.timestamp)) return null;

    let userText = (mensajeArg || "").trim();

    // Voz → transcribir
    if (!userText && isVoiceInbound(last || {})) {
        let tr = last?.transcription?.trim() || "";
        if (!tr && last?.mediaUrl) {
            try {
                const { data } = await axios.get(last.mediaUrl, { responseType: "arraybuffer" });
                tr = await transcribeAudioBuffer(Buffer.from(data), "audio.ogg");
                if (tr)
                    await prisma.message.update({ where: { id: last.id }, data: { transcription: tr } });
            } catch { }
        }
        if (tr) userText = tr;
    }
    if (!userText) userText = last?.contenido?.trim() || "";

    const kb = await loadEsteticaKB({ empresaId });
    if (!kb) {
        const msg = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: msg,
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { handoffLocked: true });
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    const { url: imageUrl, noteToAppend } = await pickImageForContext({
        conversationId: chatId,
        userText,
        caption: last?.caption || "",
        referenceTs: last?.timestamp || new Date(),
    });
    if (noteToAppend) userText += noteToAppend;

    // ====== Agendamiento flexible (colecta progresiva sin calcular hora) ======
    // 1) Actualiza draft con lo que venga en texto
    let state = await loadState(chatId);
    let nameInText = extractName(userText);
    // Fallback: si aún falta nombre y el usuario envía solo “Juan Camilo López”, tómalos como nombre.
    if (!nameInText) {
        const stateNow = await loadState(chatId);
        const needNameNow = !(stateNow.draft?.name);
        if (needNameNow) {
            const loose = looksLikeLooseName(userText);
            if (loose) nameInText = loose;
        }
    }

    const whenFree = grabWhenFreeText(userText);
    let match = resolveServiceName(kb, userText || "");
    if (!match.procedure) {
        // sinónimos mínimos
        const t = (userText || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        if (/\bbotox|toxina\b/.test(t)) {
            const tox = kb.procedures.find((p) => /toxina\s*botul/i.test(p.name));
            if (tox) match = { procedure: tox, matched: tox.name };
        } else if (/\blimpieza\b/.test(t)) {
            const limp = kb.procedures.find((p) => /limpieza/i.test(p.name));
            if (limp) match = { procedure: limp, matched: limp.name };
        } else if (/\bpeeling\b/.test(t)) {
            const pe = kb.procedures.find((p) => /peeling/i.test(p.name));
            if (pe) match = { procedure: pe, matched: pe.name };
        }
    }

    const prevDraft = state.draft ?? {};
    const newDraft = {
        ...prevDraft,
        name: prevDraft.name || nameInText || undefined,
        procedureId: prevDraft.procedureId || (match.procedure?.id ?? undefined),
        procedureName: prevDraft.procedureName || (match.procedure?.name ?? undefined),
        // whenISO: opcional—solo si detectas una fecha explícita tipo 12/11; aquí no forzamos
        whenISO: prevDraft.whenISO || undefined,
        whenText: prevDraft.whenText || whenFree || undefined, // textual SIEMPRE
    };
    const inferredIntent = detectIntent(userText, newDraft);
    await patchState(chatId, { draft: newDraft, lastIntent: inferredIntent });

    // 2) Si el usuario ya trajo todo → handoff inmediato
    if (detectHandoffReady(userText) || (newDraft.name && newDraft.procedureName && hasSomeDateDraft(newDraft))) {
        const piezasBonitas = [
            `💆 *Tratamiento:* ${newDraft.procedureName ?? "—"}`,
            `👤 *Nombre:* ${newDraft.name}`,
            newDraft.whenText
                ? `🗓️ *Preferencia:* ${newDraft.whenText}`
                : (newDraft.whenISO
                    ? `🗓️ *Fecha:* ${new Date(newDraft.whenISO).toLocaleDateString("es-CO", {
                        weekday: "long",
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                    })}`
                    : ""),
        ].filter(Boolean).join("\n");

        let cleaned = `Perfecto ✨, dame *unos minutos* mientras *verifico la disponibilidad* para ese horario y te confirmo por aquí.\n\n${piezasBonitas}`;

        cleaned = sanitizeGreeting(cleaned);
        cleaned = cleaned.replace(/\bmi\s+nombre\s+es\s+[A-ZÁÉÍÓÚÑa-záéíóúñü\s]+/gi, "").trim();
        cleaned = addEmojiStable(cleaned, chatId);

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: clampText(cleaned),
            nuevoEstado: ConversationEstado.requiere_agente,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { handoffLocked: true });
        return {
            estado: ConversationEstado.requiere_agente,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // 3) Si está fuera de alcance → redirige suave
    if (isOutOfScope(userText)) {
        const txt =
            "Puedo ayudarte con información de nuestros servicios estéticos y agendar tu cita. ¿Qué procedimiento te interesa o para qué fecha te gustaría programar? 🙂";

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto: txt,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ——— Respuesta directa a “qué servicios”
    if (/\b(que\s+servicios|qué\s+servicios|servicios\s+ofreces?)\b/i.test(userText)) {
        const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
        const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
        const items = (kb.procedures || []).slice(0, 6).map((p) => {
            const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
            return `• ${p.name}${desde}`;
        }).join("\n");

        let texto = clampText(
            `${items}\n\nSi alguno te interesa, dime el *día y hora* que prefieres agendar${human ? ` (trabajamos: ${human}${sufijoUltima})` : ""}.`
        );
        texto = addEmojiStable(texto, chatId);

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        await patchState(chatId, { lastIntent: "schedule" });
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ===== Summary extendido (cacheado y persistido en conversation_state)
    const summary = await buildOrReuseSummary({ empresaId, conversationId: chatId, kb });

    // ===== Pedir piezas SOLO si hay intención de agenda o ya hay piezas
    const needProcedure = !newDraft.procedureId && !newDraft.procedureName;
    const needWhen = !hasSomeDateDraft(newDraft);
    const needName = !newDraft.name;

    const hasServiceOrWhen = !!(newDraft.procedureId || newDraft.procedureName || newDraft.whenText || newDraft.whenISO);
    const infoBreaker = shouldBypassScheduling(userText);

    const shouldAskForAgendaPieces =
        !infoBreaker && (state.lastIntent === "schedule" || inferredIntent === "schedule" || hasServiceOrWhen);

    if (shouldAskForAgendaPieces && (needProcedure || needWhen || needName)) {
        const asks: string[] = [];
        if (needProcedure) {
            const sample = kb.procedures.slice(0, 3).map(s => s.name).join(", ");
            asks.push(`¿Para qué *tratamiento* deseas la cita? (Ej.: ${sample})`);
        }
        if (needWhen) {
            asks.push(`¿Qué *día y hora* prefieres? Escríbelo *tal cual* (ej.: “martes en la tarde” o “15/11 a las 3 pm”).`);
        }
        if (needName) {
            asks.push(`¿Cuál es tu *nombre completo*?`);
        }
        let texto = clampText(asks.join(" "));
        texto = addEmojiStable(texto, chatId);

        const saved = await sendBotReply({
            conversationId: chatId,
            empresaId,
            texto,
            nuevoEstado: ConversationEstado.respondido,
            to: toPhone ?? conversacion.phone,
            phoneNumberId,
        });
        if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);
        return {
            estado: ConversationEstado.respondido,
            mensaje: saved.texto,
            messageId: saved.messageId,
            wamid: saved.wamid,
            media: [],
        };
    }

    // ===== Respuesta libre (modo natural) usando el summary extendido
    let texto = await runLLM({ summary, userText, imageUrl }).catch(() => "");
    texto = sanitizeGreeting(texto);
    texto = clampText(texto || "¡Hola! ¿Prefieres info de tratamientos o ver opciones para agendar?");
    texto = addEmojiStable(texto, chatId);

    const saved = await sendBotReply({
        conversationId: chatId,
        empresaId,
        texto,
        nuevoEstado: ConversationEstado.respondido,
        to: toPhone ?? conversacion.phone,
        phoneNumberId,
    });

    if (last?.timestamp) markActuallyReplied(chatId, last.timestamp);

    return {
        estado: ConversationEstado.respondido,
        mensaje: saved.texto,
        messageId: saved.messageId,
        wamid: saved.wamid,
        media: [],
    };
}

/* ===== WRAPPER COMPATIBLE CON EL ORQUESTADOR ===== */
export async function handleEsteticaReply(args: {
    chatId?: number;
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
    const {
        chatId,
        conversationId: conversationIdArg,
        empresaId,
        contenido,
        toPhone,
        phoneNumberId,
    } = args;

    const conversationId = conversationIdArg ?? chatId;
    if (!conversationId) return { estado: "pendiente", mensaje: "" };

    const res = await handleEsteticaStrategy({
        chatId: conversationId,
        empresaId,
        mensajeArg: (contenido || "").trim(),
        toPhone,
        phoneNumberId,
    });

    if (!res) return { estado: "pendiente", mensaje: "" };

    return {
        estado: (res.estado as any) || ConversationEstado.respondido,
        mensaje: res.mensaje || "",
        messageId: res.messageId,
        wamid: res.wamid,
        media: res.media || [],
    };
}

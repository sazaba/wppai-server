// import prisma from "../../../lib/prisma";
// import type { Prisma, StaffRole } from "@prisma/client";
// import { MessageFrom, ConversationEstado, MediaType } from "@prisma/client";
// import { openai } from "../../../lib/openai";
// import * as Wam from "../../../services/whatsapp.service";

// import {
//     loadEsteticaKB,
//     resolveServiceName,
//     type EsteticaKB,
// } from "./esteticaModules/domain/estetica.kb";

// const CONF = {
//     MEM_TTL_MIN: 60,
//     GRAN_MIN: 15,
//     MAX_SLOTS: 6,
//     DAYS_HORIZON: 14,
//     MAX_HISTORY: 20,
//     REPLY_MAX_LINES: 5,
//     REPLY_MAX_CHARS: 900,
//     TEMPERATURE: 0.2,
//     MODEL: process.env.IA_TEXT_MODEL || process.env.IA_MODEL || "gpt-4o-mini",
// };

// // ——— Solo colecta (horarios referenciales; el equipo humano confirma)
// const COLLECT_ONLY = true;

// /* ==== Imagen (arrastre contextual) ==== */
// const IMAGE_WAIT_MS = Number(process.env.IA_IMAGE_WAIT_MS ?? 1000);
// const IMAGE_CARRY_MS = Number(process.env.IA_IMAGE_CARRY_MS ?? 60_000);
// const IMAGE_LOOKBACK_MS = Number(process.env.IA_IMAGE_LOOKBACK_MS ?? 300_000);

// /* ==== Idempotencia (memoria de proceso) ==== */
// const REPLY_DEDUP_WINDOW_MS = Number(process.env.REPLY_DEDUP_WINDOW_MS ?? 120_000);
// const processedInbound = new Map<number, number>(); // messageId -> ts
// function seenInboundRecently(messageId: number, windowMs = REPLY_DEDUP_WINDOW_MS) {
//     const now = Date.now();
//     const prev = processedInbound.get(messageId);
//     if (prev && now - prev <= windowMs) return true;
//     processedInbound.set(messageId, now);
//     return false;
// }
// const recentReplies = new Map<number, { afterMs: number; repliedAtMs: number }>();
// function shouldSkipDoubleReply(conversationId: number, clientTs: Date, windowMs = REPLY_DEDUP_WINDOW_MS) {
//     const now = Date.now();
//     const prev = recentReplies.get(conversationId);
//     const clientMs = clientTs.getTime();
//     if (prev && prev.afterMs >= clientMs && now - prev.repliedAtMs <= windowMs) return true;
//     recentReplies.set(conversationId, { afterMs: clientMs, repliedAtMs: now });
//     return false;
// }
// function markActuallyReplied(conversationId: number, clientTs: Date) {
//     const now = Date.now();
//     recentReplies.set(conversationId, { afterMs: clientTs.getTime(), repliedAtMs: now });
// }
// function normalizeToE164(n: string) {
//     return String(n || "").replace(/[^\d]/g, "");
// }

// /* ===========================
//    Helpers de agenda (DB)
//    =========================== */
// function pad2(n: number) {
//     return String(n).padStart(2, "0");
// }
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
//         SUNDAY: 0, SUNDAY_: 0, DOMINGO: 0,
//         MONDAY: 1, LUNES: 1,
//         TUESDAY: 2, MARTES: 2,
//         WEDNESDAY: 3, MIERCOLES: 3, MIÉRCULES: 3,
//         THURSDAY: 4, JUEVES: 4,
//         FRIDAY: 5, VIERNES: 5,
//         SATURDAY: 6, SABADO: 6, SÁBADO: 6,
//     };
//     return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
// }

// // — Lectura de appointmentHour
// async function fetchAppointmentHours(empresaId: number) {
//     const rows = await prisma.appointmentHour.findMany({
//         where: { empresaId },
//         orderBy: [{ day: "asc" }],
//         select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
//     });
//     return rows;
// }

// // — Lectura de excepciones (robusto)
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

// /* ===========================
//    Draft utils
//    =========================== */
// type ConversationLite = { id: number; phone: string; estado: ConversationEstado; };

// type DraftStage = "idle" | "offer" | "confirm";
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
//         timeHHMM?: string; // hora exacta (opcional)
//         timeNote?: string; // franja: mañana/tarde/noche
//         whenText?: string;
//         durationMin?: number;
//         stage?: DraftStage;
//     };
//     slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string };
//     summary?: { text: string; expiresAt: string };
//     faqsCache?: Array<{ q: string; a: string }>;
//     expireAt?: string;
//     handoffLocked?: boolean; // congela cuando pasa a requiere_agente
// };

// function nowPlusMin(min: number) {
//     return new Date(Date.now() + min * 60_000).toISOString();
// }
// async function loadState(conversationId: number): Promise<AgentState> {
//     const row = await prisma.conversationState.findUnique({ where: { conversationId }, select: { data: true } });
//     const raw = (row?.data as any) || {};
//     const data: AgentState = {
//         greeted: !!raw.greeted,
//         lastIntent: raw.lastIntent,
//         lastServiceId: raw.lastServiceId ?? null,
//         lastServiceName: raw.lastServiceName ?? null,
//         draft: raw.draft ?? {},
//         slotsCache: raw.slotsCache ?? undefined,
//         summary: raw.summary ?? undefined,
//         faqsCache: toArraySafe<{ q: string; a: string }>(raw.faqsCache),
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

// /* ===========================
//    Historial y summary
//    =========================== */
// type ChatHistoryItem = { role: "user" | "assistant"; content: string };
// async function getRecentHistory(conversationId: number, excludeMessageId?: number, take = CONF.MAX_HISTORY): Promise<ChatHistoryItem[]> {
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
//         content: softTrim(r.contenido || "", 280),
//     })) as ChatHistoryItem[];
// }

// /* ===========================
//    Manejo de imagen
//    =========================== */
// function mentionsImageExplicitly(t: string) {
//     const s = String(t || "").toLowerCase();
//     return (
//         /\b(foto|imagen|selfie|captura|screenshot)\b/.test(s) ||
//         /(mira|revisa|checa|ve|verifica)\s+la\s+(foto|imagen)/.test(s) ||
//         /(te\s+mand(e|é)|te\s+envi(e|é))\s+(la\s+)?(foto|imagen)/.test(s) ||
//         /\b(de|en)\s+la\s+(foto|imagen)\b/.test(s)
//     );
// }
// async function pickImageForContext(opts: {
//     conversationId: number;
//     directUrl?: string | null;
//     userText: string;
//     caption: string;
//     referenceTs: Date;
// }): Promise<{ url: string | null; noteToAppend: string }> {
//     const { conversationId, directUrl, userText, caption, referenceTs } = opts;
//     if (directUrl) {
//         return { url: String(directUrl), noteToAppend: caption ? `\n\nNota de la imagen: ${caption}` : "" };
//     }
//     if (!userText) return { url: null, noteToAppend: "" };

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
//         return { url: String(veryRecent.mediaUrl), noteToAppend: veryRecent.caption ? `\n\nNota de la imagen: ${veryRecent.caption}` : "" };
//     }

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
//             return { url: String(referenced.mediaUrl), noteToAppend: referenced.caption ? `\n\nNota de la imagen: ${referenced.caption}` : "" };
//         }
//     }
//     return { url: null, noteToAppend: "" };
// }

// /* ===========================
//    Summary (con horarios DB)
//    =========================== */
// async function buildOrReuseSummary(args: {
//     empresaId: number;
//     conversationId: number;
//     kb: EsteticaKB;
//     history: ChatHistoryItem[];
// }): Promise<string> {
//     const { empresaId, conversationId, kb, history } = args;

//     // — Cache
//     const cached = await loadState(conversationId);
//     const fresh = cached.summary && Date.now() < Date.parse(cached.summary.expiresAt);
//     if (fresh) return cached.summary!.text;

//     // — DB: horarios y excepciones
//     const [hoursRows, exceptionsRows, apptCfg] = await Promise.all([
//         fetchAppointmentHours(empresaId),
//         COLLECT_ONLY ? Promise.resolve([]) : fetchAppointmentExceptions(empresaId, 35),
//         prisma.businessConfigAppt.findUnique({
//             where: { empresaId },
//             select: {
//                 // ===== Flags y parámetros base de agenda
//                 appointmentEnabled: true,
//                 appointmentVertical: true,
//                 appointmentVerticalCustom: true,
//                 appointmentTimezone: true,
//                 appointmentBufferMin: true,
//                 appointmentPolicies: true,
//                 appointmentReminders: true,

//                 // ===== Reglas operativas claras
//                 appointmentMinNoticeHours: true,
//                 appointmentMaxAdvanceDays: true,
//                 allowSameDayBooking: true,
//                 requireClientConfirmation: true,
//                 cancellationAllowedHours: true,
//                 rescheduleAllowedHours: true,
//                 defaultServiceDurationMin: true,

//                 // ===== Servicios
//                 servicesText: true,
//                 services: true,

//                 // ===== Logística
//                 locationName: true,
//                 locationAddress: true,
//                 locationMapsUrl: true,
//                 parkingInfo: true,
//                 virtualMeetingLink: true,
//                 instructionsArrival: true,

//                 // ===== Reglas operativas
//                 cancellationWindowHours: true,
//                 noShowPolicy: true,
//                 depositRequired: true,
//                 depositAmount: true,
//                 maxDailyAppointments: true,
//                 bookingWindowDays: true,
//                 blackoutDates: true,
//                 overlapStrategy: true,

//                 // ===== Recordatorios / comunicaciones
//                 reminderSchedule: true,
//                 reminderTemplateId: true,
//                 postBookingMessage: true,
//                 prepInstructionsPerSvc: true,

//                 // ===== Consentimiento / compliance
//                 requireWhatsappOptIn: true,
//                 allowSensitiveTopics: true,
//                 minClientAge: true,

//                 // ===== Knowledge Base libre
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

//     const { human: hoursLine } = await buildBusinessRangesHuman(empresaId, kb, { rows: hoursRows });

//     let exceptionsLine = "";
//     if (!COLLECT_ONLY) {
//         const exceptions = normalizeExceptions(exceptionsRows);
//         const closedSoon = exceptions.filter(e => e.closed).slice(0, 10).map(e => e.date).join(", ");
//         if (closedSoon) exceptionsLine = `Excepciones agenda (DB): ${closedSoon} (cerrado)`;
//     }

//     // ====== Servicios del catálogo (de KB de estética)
//     const svcFromKB = (kb.procedures ?? [])
//         .filter(s => s.enabled !== false)
//         .map(s => (s.priceMin ? `${s.name} (Desde ${formatCOP(s.priceMin)} COP)` : s.name))
//         .join(" • ");

//     // ====== Staff por rol
//     const staffByRole: Record<StaffRole, string[]> = { esteticista: [], medico: [], profesional: [] } as any;
//     (kb.staff || []).forEach(s => { if (s.active) (staffByRole[s.role] ||= []).push(s.name); });

//     // ====== Métodos de pago (de KB)
//     const pmFromArrays = (() => {
//         const pm: any = (kb as any).paymentMethods ?? (kb as any).payments ?? [];
//         const list: string[] = [];
//         if (Array.isArray(pm)) {
//             for (const it of pm) {
//                 if (!it) continue;
//                 if (typeof it === "string") list.push(it);
//                 else if (typeof it?.name === "string") list.push(it.name);
//             }
//         }
//         return list;
//     })();
//     const pmFlags: Array<[string, any]> = [
//         ["Efectivo", (kb as any).cash],
//         ["Tarjeta débito/crédito", (kb as any).card || (kb as any).cards],
//         ["Transferencia", (kb as any).transfer || (kb as any).wire],
//         ["PSE", (kb as any).pse],
//         ["Nequi", (kb as any).nequi],
//         ["Daviplata", (kb as any).daviplata],
//     ];
//     const pmFromFlags = pmFlags.filter(([_, v]) => v === true).map(([label]) => label);
//     const paymentsList = Array.from(new Set([...pmFromArrays, ...pmFromFlags].filter(Boolean))).sort();
//     const paymentsLine = paymentsList.length ? `Pagos: ${paymentsList.join(" • ")}` : "";

//     // ====== Secciones provenientes 100% de businessconfig_appt
//     const S = apptCfg || ({} as any);

//     // — Flags/params base
//     const flagsBase: string[] = [];
//     flagsBase.push(`Agenda: ${S.appointmentEnabled ? "habilitada" : "deshabilitada"}`);
//     flagsBase.push(`Vertical: ${String(S.appointmentVertical || "custom")}${S.appointmentVertical === "custom" && S.appointmentVerticalCustom ? ` (${S.appointmentVerticalCustom})` : ""}`);
//     flagsBase.push(`TZ: ${String(S.appointmentTimezone || kb.timezone)}`);
//     if (S.appointmentBufferMin != null) flagsBase.push(`Buffer ${S.appointmentBufferMin} min`);
//     if (S.defaultServiceDurationMin != null) flagsBase.push(`Duración por defecto ${S.defaultServiceDurationMin} min`);
//     if (S.appointmentPolicies) flagsBase.push(`Políticas: ${softTrim(String(S.appointmentPolicies), 220)}`);
//     flagsBase.push(`Recordatorios: ${S.appointmentReminders ? "sí" : "no"}`);

//     // — Reglas operativas claras
//     const reglasClaras: string[] = [];
//     if (S.allowSameDayBooking != null) reglasClaras.push(`Misma día: ${S.allowSameDayBooking ? "permitido" : "no"}`);
//     if (S.appointmentMinNoticeHours != null) reglasClaras.push(`Anticipación mínima ${S.appointmentMinNoticeHours} h`);
//     if (S.appointmentMaxAdvanceDays != null) reglasClaras.push(`Reserva hasta ${S.appointmentMaxAdvanceDays} días`);
//     if (S.requireClientConfirmation != null) reglasClaras.push(`Requiere confirmación cliente: ${S.requireClientConfirmation ? "sí" : "no"}`);
//     if (S.cancellationAllowedHours != null) reglasClaras.push(`Cancelación hasta ${S.cancellationAllowedHours} h`);
//     if (S.rescheduleAllowedHours != null) reglasClaras.push(`Reagendo hasta ${S.rescheduleAllowedHours} h`);

//     // — Servicios (texto libre + array)
//     const serviciosCfg: string[] = [];
//     if (S.servicesText) serviciosCfg.push(`Servicios (texto): ${softTrim(S.servicesText, 300)}`);
//     if (Array.isArray(S.services) && S.services.length) serviciosCfg.push(`Servicios (lista): ${S.services.join(" • ")}`);

//     // — Logística / ubicación
//     const logist: string[] = [];
//     if (S.locationName) logist.push(`Sede: ${S.locationName}`);
//     if (S.locationAddress) logist.push(`Dirección: ${S.locationAddress}`);
//     if (S.locationMapsUrl) logist.push(`Mapa: ${S.locationMapsUrl}`);
//     if (S.parkingInfo) logist.push(`Parqueadero: ${softTrim(S.parkingInfo, 160)}`);
//     if (S.virtualMeetingLink) logist.push(`Link virtual: ${S.virtualMeetingLink}`);
//     if (S.instructionsArrival) logist.push(`Indicaciones: ${softTrim(S.instructionsArrival, 220)}`);

//     // — Reglas operativas extra
//     const reglasOp: string[] = [];
//     if (S.cancellationWindowHours != null) reglasOp.push(`Ventana de cancelación: ${S.cancellationWindowHours} h`);
//     if (S.noShowPolicy) reglasOp.push(`No-show: ${softTrim(S.noShowPolicy, 220)}`);
//     if (S.depositRequired != null) reglasOp.push(`Depósito: ${S.depositRequired ? (S.depositAmount != null ? `sí (${formatCOP(Number(S.depositAmount))})` : "sí") : "no"}`);
//     if (S.maxDailyAppointments != null) reglasOp.push(`Máx. citas/día: ${S.maxDailyAppointments}`);
//     if (S.bookingWindowDays != null) reglasOp.push(`Ventana de reserva: ${S.bookingWindowDays} días`);
//     if (Array.isArray(S.blackoutDates) && S.blackoutDates.length) {
//         const blacks = (S.blackoutDates as any[]).map(d => (typeof d === "string" ? d : JSON.stringify(d))).slice(0, 10).join(", ");
//         reglasOp.push(`Fechas bloqueadas: ${blacks}${(S.blackoutDates as any[]).length > 10 ? "…" : ""}`);
//     }
//     if (S.overlapStrategy) reglasOp.push(`Solapamiento: ${S.overlapStrategy}`);

//     // — Recordatorios / comunicaciones
//     const comms: string[] = [];
//     if (Array.isArray(S.reminderSchedule) && S.reminderSchedule.length) {
//         const items = (S.reminderSchedule as any[])
//             .map((r: any) => {
//                 const h = r?.offsetHours != null ? `${r.offsetHours} h` : "—";
//                 const ch = r?.channel ? String(r.channel) : "—";
//                 return `${h}/${ch}`;
//             }).slice(0, 8).join(" • ");
//         comms.push(`Recordatorios: ${items}`);
//     }
//     if (S.reminderTemplateId) comms.push(`Plantilla recordatorio: ${S.reminderTemplateId}`);
//     if (S.postBookingMessage) comms.push(`Mens. post-reserva: ${softTrim(S.postBookingMessage, 200)}`);
//     if (S.prepInstructionsPerSvc && typeof S.prepInstructionsPerSvc === "object") {
//         const keys = Object.keys(S.prepInstructionsPerSvc as any);
//         if (keys.length) {
//             const list = keys.slice(0, 8).map(k => `${k}: ${softTrim((S.prepInstructionsPerSvc as any)[k], 120)}`).join(" | ");
//             comms.push(`Prep x servicio: ${list}${keys.length > 8 ? "…" : ""}`);
//         }
//     }

//     // — Consentimiento / compliance
//     const compliance: string[] = [];
//     if (S.requireWhatsappOptIn != null) compliance.push(`WhatsApp opt-in: ${S.requireWhatsappOptIn ? "requerido" : "no"}`);
//     if (S.allowSensitiveTopics != null) compliance.push(`Temas sensibles: ${S.allowSensitiveTopics ? "permitidos" : "no"}`);
//     if (S.minClientAge != null) compliance.push(`Edad mínima: ${S.minClientAge}`);

//     // — Knowledge base libre
//     const kbLines: string[] = [];
//     if (S.kbBusinessOverview) kbLines.push(`Overview: ${softTrim(S.kbBusinessOverview, 260)}`);
//     const faqsParsed = toArraySafe<any>(S.kbFAQs);
//     if (faqsParsed.length) {
//         const qs = faqsParsed
//             .map((f: any) => (f?.q || f?.title || ""))
//             .filter(Boolean)
//             .slice(0, 8)
//             .join(" • ");
//         if (qs) kbLines.push(`FAQs: ${qs}${faqsParsed.length > 8 ? "…" : ""}`);
//     }

//     if (S.kbServiceNotes && typeof S.kbServiceNotes === "object") {
//         const nkeys = Object.keys(S.kbServiceNotes as any);
//         if (nkeys.length) kbLines.push(`Notas por servicio: ${nkeys.slice(0, 10).join(" • ")}${nkeys.length > 10 ? "…" : ""}`);
//     }
//     if (S.kbEscalationRules) kbLines.push(`Reglas de escalamiento: ${softTrim(JSON.stringify(S.kbEscalationRules), 220)}`);
//     if (S.kbDisclaimers) kbLines.push(`Disclaimers: ${softTrim(S.kbDisclaimers, 240)}`);
//     if (Array.isArray(S.kbMedia) && S.kbMedia.length) kbLines.push(`Media (attachments): ${S.kbMedia.length} ítems`);
//     if (S.kbFreeText) kbLines.push(`Notas libres: ${softTrim(S.kbFreeText, 260)}`);

//     // ====== Reglas/Logística rápidas (de KB “ligero”)
//     const rulesQuick: string[] = [];
//     if (kb.bufferMin) rulesQuick.push(`Buffer ${kb.bufferMin} min`);
//     if (kb.defaultServiceDurationMin) rulesQuick.push(`Duración por defecto ${kb.defaultServiceDurationMin} min`);

//     const logisticsQuick: string[] = [];
//     if (kb.location?.name) logisticsQuick.push(`Sede: ${kb.location.name}`);
//     if (kb.location?.address) logisticsQuick.push(`Dirección: ${kb.location.address}`);

//     // ====== Staff line
//     const staffLine =
//         Object.entries(staffByRole).some(([_, arr]) => (arr?.length ?? 0) > 0)
//             ? `Staff: ${[
//                 staffByRole.medico?.length ? `Médicos: ${staffByRole.medico.join(", ")}` : "",
//                 staffByRole.esteticista?.length ? `Esteticistas: ${staffByRole.esteticista.join(", ")}` : "",
//                 staffByRole.profesional?.length ? `Profesionales: ${staffByRole.profesional.join(", ")}` : "",
//             ].filter(Boolean).join(" | ")}`
//             : "";

//     // ====== Construcción del bloque base con TODO
//     const base = [
//         // Encabezado negocio
//         kb.businessName ? `Negocio: ${kb.businessName}` : "Negocio: Clínica estética",
//         `Zona horaria: ${S.appointmentTimezone || kb.timezone}`,

//         // Flags base agenda
//         flagsBase.join(" | "),

//         // Reglas operativas claras
//         reglasClaras.length ? `Reglas: ${reglasClaras.join(" | ")}` : "",

//         // Logística
//         logist.length ? `Logística: ${logist.join(" | ")}` : "",

//         // Reglas operativas extra
//         reglasOp.length ? `Operativa: ${reglasOp.join(" | ")}` : "",

//         // Catálogo / servicios
//         serviciosCfg.length ? serviciosCfg.join("\n") : "",
//         svcFromKB ? `Servicios (KB): ${svcFromKB}` : "",

//         // Medios de pago
//         paymentsLine,

//         // Staff
//         staffLine,

//         // Horario y excepciones
//         hoursLine ? `Horario base (DB): ${hoursLine}` : "",
//         exceptionsLine,

//         // Communications
//         comms.length ? `Comunicaciones: ${comms.join(" | ")}` : "",

//         // Compliance
//         compliance.length ? `Compliance: ${compliance.join(" | ")}` : "",

//         // Knowledge libre
//         kbLines.length ? kbLines.join("\n") : "",

//         // Reglas y logística rápidas (de KB)
//         rulesQuick.length ? rulesQuick.join(" | ") : "",
//         logisticsQuick.length ? logisticsQuick.join(" | ") : "",

//         // Excepciones definidas en KB (si existieran)
//         kb.exceptions?.length
//             ? `Excepciones próximas (KB): ${kb.exceptions
//                 .slice(0, 3)
//                 .map(e => `${e.dateISO}${e.isOpen === false ? " cerrado" : ""}`)
//                 .join(", ")}`
//             : "",

//         // Historial para dar color
//         `Historial breve: ${history
//             .slice(-6)
//             .map(h => (h.role === "user" ? `U:` : `A:`) + softTrim(h.content, 100))
//             .join(" | ")}`,
//     ]
//         .filter(Boolean)
//         .join("\n");

//     // — Compactamos (pero pasamos TODO en "base" al prompt del resumen)
//     let compact = base;
//     try {
//         const resp: any =
//             (openai as any).chat?.completions?.create
//                 ? await (openai as any).chat.completions.create({
//                     model: CONF.MODEL,
//                     temperature: 0.1,
//                     max_tokens: 220,
//                     messages: [
//                         { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
//                         { role: "user", content: base.slice(0, 4000) }, // pasa TODO (capado a 4k chars)
//                     ],
//                 })
//                 : await (openai as any).createChatCompletion({
//                     model: CONF.MODEL,
//                     temperature: 0.1,
//                     max_tokens: 220,
//                     messages: [
//                         { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. Español neutro." },
//                         { role: "user", content: base.slice(0, 4000) },
//                     ],
//                 });
//         compact = (resp?.choices?.[0]?.message?.content || base).trim().replace(/\n{3,}/g, "\n\n");
//     } catch {
//         // fallback deja base tal cual
//     }

//     await patchState(conversationId, { summary: { text: compact, expiresAt: nowPlusMin(CONF.MEM_TTL_MIN) } });
//     return compact;
// }


// /* ===========================
//    Intención / tono
//    =========================== */
// function detectIntent(text: string): "price" | "schedule" | "reschedule" | "cancel" | "info" | "other" {
//     const t = (text || "").toLowerCase();
//     if (/\b(precio|costo|valor|tarifa|cu[aá]nto)\b/.test(t)) return "price";
//     if (/\b(horario|horarios|disponibilidad|cupo|agenda[rs]?|agendar|programar|reservar)\b/.test(t)) return "schedule";
//     if (/\b(reagendar|cambiar|mover|otra hora|reprogramar)\b/.test(t)) return "reschedule";
//     if (/\b(cancelar|anular)\b/.test(t)) return "cancel";
//     if (/\b(beneficios?|indicaciones|cuidados|contraindicaciones|en qu[eé] consiste|como funciona)\b/.test(t)) return "info";
//     return "other";
// }
// function detectExactPriceQuery(text: string): boolean {
//     const t = (text || "").toLowerCase();
//     return /\b(precio\s+exacto|exacto\s+seg[uú]n\s+mi\s+caso|precio\s+final)\b/.test(t);
// }
// function varyPrefix(kind: "offer" | "ask" | "ok"): string {
//     const sets = {
//         offer: ["Te cuento rápido:", "Resumen:", "Puntos clave:"],
//         ask: ["¿Te paso opciones…?", "¿Seguimos con…?", "¿Quieres ver horarios?"],
//         ok: ["Perfecto ✅", "¡Listo! ✨", "Genial 🙌"],
//     } as const;
//     const arr = sets[kind];
//     return arr[Math.floor(Math.random() * arr.length)];
// }

// /* ===========================
//    Sinónimos y staff
//    =========================== */
// function pickStaffForProcedure(kb: EsteticaKB, proc?: EsteticaKB["procedures"][number] | null) {
//     const active = (kb.staff || []).filter((s) => s.active);
//     if (!active.length) return null;
//     if (proc?.requiredStaffIds?.length) {
//         const byId = active.find((s) => proc.requiredStaffIds!.includes(s.id));
//         if (byId) return byId;
//     }
//     if (proc?.requiresAssessment) {
//         const medico = active.find((s) => s.role === "medico");
//         if (medico) return medico;
//     }
//     const esteticista = active.find((s) => s.role === "esteticista");
//     if (esteticista) return esteticista;
//     return active[0];
// }
// function resolveBySynonyms(kb: EsteticaKB, text: string) {
//     const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     if (/\bbotox|botox\b/.test(t) || /\btoxina\b/.test(t)) {
//         const tox = kb.procedures.find((p) => /toxina\s*botul/i.test(p.name));
//         if (tox) return tox;
//     }
//     if (/\blimpieza\b/.test(t)) {
//         const limp = kb.procedures.find((p) => /limpieza/i.test(p.name));
//         if (limp) return limp;
//     }
//     if (/\bpeeling\b/.test(t)) {
//         const pe = kb.procedures.find((p) => /peeling/i.test(p.name));
//         if (pe) return pe;
//     }
//     return null;
// }

// /* ===========================
//    Utils de formato
//    =========================== */
// function softTrim(s: string | null | undefined, max = 240) {
//     const t = (s || "").trim();
//     if (!t) return "";
//     return t.length <= max ? t : t.slice(0, max).replace(/\s+[^\s]*$/, "") + "…";
// }
// function endsWithPunctuation(t: string) {
//     return /[.!?…]\s*$/.test((t || "").trim());
// }
// function closeNicely(raw: string) {
//     let t = (raw || "").trim();
//     if (!t) return t;
//     if (endsWithPunctuation(t)) return t;
//     t = t.replace(/\s+[^\s]*$/, "").trim();
//     return t ? `${t}…` : raw.trim();
// }
// function clampLines(text: string, maxLines = CONF.REPLY_MAX_LINES) {
//     const lines = (text || "").split("\n").filter(Boolean);
//     if (lines.length <= maxLines) return text;
//     const t = lines.slice(0, maxLines).join("\n").trim();
//     return /[.!?…]$/.test(t) ? t : `${t}…`;
// }
// function formatCOP(value?: number | null): string | null {
//     if (value == null || isNaN(Number(value))) return null;
//     return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(Number(value));
// }
// // --- PATCH: detector métodos de pago ---
// function isPaymentQuestion(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return /\b(pagos?|metodos? de pago|formas? de pago|tarjeta|efectivo|transferencia|financiaci[oó]n|credito|cr[eé]dito|cuotas?)\b/.test(s);
// }

// function readPaymentMethodsFromKB(kb: EsteticaKB): string[] {
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

// // ==== FAQ HELPERS (BEGIN) ====
// // Convierte valores (array | string JSON | null) a array seguro
// function toArraySafe<T = any>(val: any): T[] {
//     if (!val) return [];
//     if (Array.isArray(val)) return val as T[];
//     if (typeof val === "string") {
//         try {
//             const parsed = JSON.parse(val);
//             return Array.isArray(parsed) ? (parsed as T[]) : [];
//         } catch {
//             return [];
//         }
//     }
//     return [];
// }

// // Normaliza texto a tokens limpias
// function normTokens(text: string): string[] {
//     return (text || "")
//         .toLowerCase()
//         .normalize("NFD")
//         .replace(/\p{Diacritic}/gu, "")          // quita acentos
//         .replace(/[^\p{L}\p{N}\s]+/gu, " ")      // ⬅️ quita TODO signo/puntuación (incluye ¿?¡!.,…)
//         .replace(/\s+/g, " ")
//         .trim()
//         .split(" ")
//         .filter(Boolean);
// }


// // Similaridad Jaccard simple entre conjuntos de tokens
// function jaccard(a: Set<string>, b: Set<string>) {
//     const inter = new Set([...a].filter(x => b.has(x))).size;
//     const uni = new Set([...a, ...b]).size || 1;
//     return inter / uni;
// }

// // Une FAQs de dos fuentes evitando duplicados por pregunta (q) — acepta array o string JSON
// function mergeFaqs(
//     a?: Array<{ q?: string; a?: string }> | string | null,
//     b?: Array<{ q?: string; a?: string }> | string | null
// ): Array<{ q: string; a: string }> {
//     const list: Array<{ q: string; a: string }> = [];
//     const push = (q?: string, a?: string) => {
//         const qq = (q || "").trim();
//         const aa = (a || "").trim();
//         if (!qq || !aa) return;
//         if (!list.some(x => x.q.toLowerCase() === qq.toLowerCase())) list.push({ q: qq, a: aa });
//     };

//     const A = toArraySafe<{ q?: string; a?: string }>(a);
//     const B = toArraySafe<{ q?: string; a?: string }>(b);
//     A.forEach(x => push(x?.q, x?.a));
//     B.forEach(x => push(x?.q, x?.a));
//     return list;
// }



// // Devuelve la mejor respuesta de FAQ si supera umbral
// function answerFromFAQs(
//     faqs: Array<{ q: string; a: string }>,
//     userText: string
// ): string | null {
//     if (!faqs?.length || !userText) return null;
//     const uSet = new Set(normTokens(userText));

//     // Peso extra si la pregunta aparece como substring
//     let best: { score: number; a: string } = { score: 0, a: "" };

//     for (const f of faqs) {
//         const q = (f.q || "").trim();
//         const a = (f.a || "").trim();
//         if (!q || !a) continue;

//         const qSet = new Set(normTokens(q));
//         let score = jaccard(uSet, qSet);

//         // Bonificación por substring directo
//         if (userText.toLowerCase().includes(q.toLowerCase())) score += 0.25;

//         // Bonificación leve por palabras clave obvias
//         const hints = ["metodo", "metodos", "pagos", "pago", "niños", "menores", "profesional", "esteticista", "doctor", "doctora", "tarjeta", "efectivo", "transferencia"];
//         if (hints.some(h => q.toLowerCase().includes(h) && userText.toLowerCase().includes(h))) score += 0.1;

//         if (score > best.score) best = { score, a };
//     }

//     // Umbral conservador (0.32) + posible boost por substring
//     return best.score >= 0.32 ? best.a : null;
// }
// // ==== FAQ HELPERS (END) ====


// // --- NUEVO: detectores/limpiadores de agenda ---
// function isSchedulingCue(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return (
//         /\b(agendar|agenda|reservar|programar)\b/.test(s) ||
//         /quieres ver horarios|te paso horarios|dime el dia y hora|que dia y hora prefieres/.test(s)
//     );
// }

// // ⬇️ AFINADO: incluye frases “no tengo acceso a la agenda/sistema de agendamiento…”
// function sanitizeNoAccessAgenda(t: string): { text: string; flagged: boolean } {
//     const bad = /(no\s+(tengo|tenemos)\s+acceso\s+(directo\s+)?(al|a la)\s+(sistema\s+de\s+)?agend(a|amiento)|no\s+puedo\s+agend)/i;
//     if (bad.test(t)) {
//         const cleaned = t.replace(bad, "").replace(/\s{2,}/g, " ").trim();
//         const tail = " Si te parece, cuéntame tu *día y hora* preferidos y el equipo confirma por aquí. 🗓️";
//         return { text: (cleaned || "Puedo ayudarte a reservar.").trim() + tail, flagged: true };
//     }
//     return { text: t, flagged: false };
// }


// // ——— Corta el flujo de agenda cuando el texto es informativo/educativo ———
// function isShortQuestion(t: string): boolean {
//     const s = (t || "").trim();
//     const noSpaces = s.replace(/\s+/g, "");
//     const hasQM = /[?¿]$/.test(s) || s.includes("?") || s.includes("¿");
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

// // Preguntas informativas comunes (ampliable sin romper)
// function isGeneralInfoQuestion(t: string): boolean {
//     const s = (t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     return (
//         // qué/cómo/cuánto/puedo/hay/tienen/atienden... (sin agenda)
//         /\b(que es|de que se trata|como funciona|beneficios?|riesgos?|efectos secundarios?|contraindicaciones?|cuidados|pre|pos|post|cuanto dura|duracion|marcas?|quien lo hace|profesional|doctor(a)?)\b/.test(s) ||
//         /\b(hay|tienen|se puede|puedo|atienden|edad|minima|dolor|recuperaci[oó]n|cicatrices?|manchas|acne|rosacea|melasma|embarazo|lactancia)\b/.test(s) ||
//         isPaymentQuestion(t) ||
//         /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|sede|como llego|parqueadero|parqueo|estacionamiento|parking)\b/.test(s)
//     );
// }

// // Regla maestro: ¿debemos saltarnos la agenda en este turno?
// function shouldBypassScheduling(t: string): boolean {
//     // Si tiene señales de agenda → NO bypass
//     if (isSchedulingCue(t) || containsDateOrTimeHints(t)) return false;
//     // Si es pregunta corta o entra en categoría informativa/educativa → bypass
//     if (isShortQuestion(t) || isGeneralInfoQuestion(t) || isEducationalQuestion(t)) return true;
//     return false;
// }


// /* ===========================
//    Saludo (anti-doble saludo)
//    =========================== */
// const GREETER_NAME = process.env.GREETER_NAME ?? "Angélica";

// /** Elimina cualquier intro/saludo al inicio del LLM (deja solo el nuestro). */
// function stripIntro(raw: string): string {
//     let t = (raw || "").trim();
//     const INTRO_PATTERNS: RegExp[] = [
//         /^\s*[¡!"]?\s*(hola|buen[oa]s|buen(?:\s*d[ií]a)|buenas\s+tardes|buenas\s+noches)\b[^\n.!?…]*[.!?…]?\s*/i,
//         /^\s*¡?\s*bienvenid[oa]s?[^\n.!?…]*[.!?…]?\s*/i,
//         /^\s*soy\s+(tu\s+(asesor|asistente|bot)|[a-záéíóúñ\s]+?)(\s+de\s+[^\n.?!…]+)?[^\n.!?…]*[.!?…]?\s*/i,
//         /^\s*(estoy|estamos)\s+para\s+ayudarte[^\n.!?…]*[.!?…]?\s*/i,
//         /^\s*¿?\s*en\s+qu[eé]\s+(te|le)\s+puedo\s+ayudar(?:\s+hoy)?\s*\??\s*/i,
//         /^\s*gracias\s+por\s+escribir[^\n.!?…]*[.!?…]?\s*/i,
//         /^\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*(soy|somos)\s+(tu\s+)?(asesor|asistente|bot)[^\n.!?…]*[.!?…]?\s*/u,
//         /^\s*(asesor | asistente) \s + virtual[^\n.! ?…] * [.! ?…] ?\s* /i
//     ];
//     for (let i = 0; i < 3; i++) {
//         const before = t;
//         for (const re of INTRO_PATTERNS) t = t.replace(re, "").trim();
//         if (t === before) break;
//     }
//     return t;
// }

// /** ÚNICO saludo de Angélica (solo si es la primera respuesta del bot). */
// async function maybePrependGreeting(opts: {
//     conversationId: number;
//     kbName?: string | null;
//     text: string;
//     state: AgentState;
// }): Promise<{ text: string; greetedNow: boolean }> {
//     const { conversationId, state } = opts;
//     let text = stripIntro(opts.text);

//     // Si ya saludó en esta conversación, no repite
//     if (state.greeted) return { text, greetedNow: false };

//     // Evitar saludos duplicados si ya hubo mensaje anterior del bot
//     const prevBotMsg = await prisma.message.findFirst({
//         where: { conversationId, from: MessageFrom.bot },
//         select: { id: true },
//     });
//     if (prevBotMsg) return { text, greetedNow: false };

//     // Saludo más corto y natural
//     const hi = `Hola 👋 Soy ${GREETER_NAME}. `;
//     const greeting = `${hi}${text}`.trim();

//     await patchState(conversationId, { greeted: true });
//     return { text: greeting, greetedNow: true };
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

// /* ===========================
//    Persistencia + WhatsApp
//    =========================== */
// async function persistBotReply(opts: {
//     conversationId: number;
//     empresaId: number;
//     texto: string;
//     nuevoEstado: ConversationEstado;
//     to?: string;
//     phoneNumberId?: string;
// }) {
//     const { conversationId, empresaId, texto, nuevoEstado, to, phoneNumberId } = opts;

//     const prevBot = await prisma.message.findFirst({
//         where: { conversationId, from: MessageFrom.bot },
//         orderBy: { timestamp: "desc" },
//         select: { id: true, contenido: true, timestamp: true, externalId: true },
//     });
//     if (prevBot) {
//         const sameText = (prevBot.contenido || "").trim() === (texto || "").trim();
//         const recent = Date.now() - new Date(prevBot.timestamp as any).getTime() <= 15_000;
//         if (sameText && recent) {
//             console.log('[persist] set estado ->', nuevoEstado, { conversationId, mode: 'dedup' });
//             await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });
//             return { messageId: prevBot.id, texto: prevBot.contenido, wamid: prevBot.externalId as any, estado: nuevoEstado };
//         }
//     }

//     const msg = await prisma.message.create({ data: { conversationId, from: MessageFrom.bot, contenido: texto, empresaId } });
//     console.log('[persist] set estado ->', nuevoEstado, { conversationId, mode: 'normal' });
//     await prisma.conversation.update({ where: { id: conversationId }, data: { estado: nuevoEstado } });

//     let wamid: string | undefined;
//     if (to && String(to).trim()) {
//         try {
//             const resp = await (Wam as any).sendWhatsappMessage({
//                 empresaId,
//                 to: normalizeToE164(to),
//                 body: texto,
//                 phoneNumberIdHint: phoneNumberId,
//             });
//             wamid = (resp as any)?.data?.messages?.[0]?.id || (resp as any)?.messages?.[0]?.id;
//             if (wamid) await prisma.message.update({ where: { id: msg.id }, data: { externalId: wamid } });
//         } catch (e) {
//             console.error("[ESTETICA] WA send error:", (e as any)?.message || e);
//         }
//     }
//     return { messageId: msg.id, texto, wamid, estado: nuevoEstado };
// }

// /* ===========================
//    Detector + extractores
//    =========================== */
// function detectScheduleAsk(t: string): boolean {
//     const s = (t || "").toLowerCase();
//     return /\b(agendar|reservar|programar|cita|agenda|horarios|disponibilidad)\b/.test(s);
// }
// function extractName(raw: string): string | null {
//     const t = (raw || "").trim();
//     let m =
//         t.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ\s]{2,50})/i) ||
//         t.match(/\b([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})\b.*(cel|tel|whatsapp)/i);
//     if (m && m[1]) return m[1].trim().replace(/\s+/g, " ");
//     const onlyLetters = /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2}$/;
//     if (onlyLetters.test(t) && t.length >= 3 && t.length <= 60) return t.replace(/\s+/g, " ");
//     return null;
// }
// function extractWhen(raw: string): { label?: string; iso?: string } | null {
//     const t = (raw || "").toLowerCase();
//     const now = new Date();
//     if (/\b(hoy)\b/.test(t)) return { label: "hoy", iso: now.toISOString() };
//     if (/\b(mañana|manana)\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return { label: "mañana", iso: d.toISOString() }; }
//     const wdMap: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
//     const key = Object.keys(wdMap).find(k => t.includes(k));
//     if (key) {
//         const target = wdMap[key];
//         const d = new Date(now);
//         let daysAhead = (target - d.getDay() + 7) % 7;
//         if (daysAhead === 0) daysAhead = 7;
//         d.setDate(d.getDate() + daysAhead);
//         return { label: key, iso: d.toISOString() };
//     }
//     const m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+a\s+las\s+(\d{1,2})(?::(\d{2}))?)?\b/);
//     if (m) {
//         const [, dd, mm, yyyyOpt, hhOpt, miOpt] = m;
//         const yyyy = yyyyOpt ? Number(yyyyOpt.length === 2 ? "20" + yyyyOpt : yyyyOpt) : now.getFullYear();
//         const d = new Date(yyyy, Number(mm) - 1, Number(dd), hhOpt ? Number(hhOpt) : 9, miOpt ? Number(miOpt) : 0, 0);
//         return { label: "fecha indicada", iso: d.toISOString() };
//     }
//     return null;
// }
// function extractDayPeriod(raw: string): string | null {
//     const t = (raw || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     if (/\b(ma[nñ]ana|por la ma[nñ]ana|en la ma[nñ]ana)\b/.test(t)) return "mañana";
//     if (/\b(tarde|por la tarde|en la tarde)\b/.test(t)) return "tarde";
//     if (/\b(noche|por la noche|en la noche)\b/.test(t)) return "noche";
//     if (/\b(mediodia|medio dia)\b/.test(t)) return "mediodía";
//     return null;
// }
// function extractHour(raw: string): string | null {
//     const t = (raw || "").toLowerCase().replace(/\s+/g, " ").trim();
//     let m = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/);
//     if (m) {
//         let hh = parseInt(m[1], 10);
//         const mm = parseInt(m[2], 10);
//         const suf = (m[3] || "").replace(/\./g, "");
//         if (suf === "pm" && hh < 12) hh += 12;
//         if (suf === "am" && hh === 12) hh = 0;
//         if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
//     }
//     m = t.match(/\b(?:a\s+las?\s+)?(\d{1,2})(?:\s*(a\.?m\.?|p\.?m\.?|am|pm))?\b/);
//     if (m) {
//         let hh = parseInt(m[1], 10);
//         const suf = (m[2] || "").replace(/\./g, "");
//         if (suf === "pm" && hh < 12) hh += 12;
//         if (suf === "am" && hh === 12) hh = 0;
//         if (hh >= 0 && hh <= 23) return `${String(hh).padStart(2, "0")}:00`;
//     }
//     return null;
// }
// function fmtHourLabel(hhmm?: string): string | null {
//     if (!hhmm) return null;
//     const [h, m] = hhmm.split(":").map(Number);
//     if (isNaN(h) || isNaN(m)) return null;
//     const suf = h >= 12 ? "p. m." : "a. m.";
//     const hr12 = h % 12 === 0 ? 12 : h % 12;
//     return `${hr12}:${String(m).padStart(2, "0")} ${suf}`;
// }
// function hasSomeDate(d?: AgentState["draft"]) {
//     return !!(d?.whenISO || d?.timeHHMM || d?.timeNote || d?.whenText);
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

// async function tagAsSchedulingNeeded(opts: { conversationId: number; empresaId: number; label?: string }) {
//     const { conversationId } = opts;
//     console.log('[handoff] tagging requiere_agente ->', { conversationId });
//     await prisma.conversation.update({ where: { id: conversationId }, data: { estado: ConversationEstado.requiere_agente } });
//     await patchState(conversationId, { handoffLocked: true });
// }

// /* ===========================
//    Clasificador de MODO
//    =========================== */
// function isEducationalQuestion(text: string): boolean {
//     const t = (text || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
//     if (/\b(que es|de que se trata|como funciona|como actua|beneficios?|riesgos?|efectos secundarios?|cuidados|contraindicaciones?)\b/.test(t)) return true;
//     if (/\b(b[óo]tox|toxina|acido hialuronico|peeling|hidratar|manchas|acne|rosacea|cicatrices|arrugas|poros|melasma|flacidez)\b/.test(t)) return true;
//     if (/\b(recomendable|conviene|sirve|me ayuda|me funciona)\b/.test(t) && /\b(rosacea|acne|melasma|hiperpigmentacion|cicatriz|flacidez|arrugas|manchas)\b/.test(t)) return true;
//     return false;
// }

// /* ===========================
//    Núcleo
//    =========================== */
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
//     const { chatId, conversationId: conversationIdArg, empresaId, toPhone, phoneNumberId } = args;
//     let contenido = (args.contenido || "").trim();

//     const conversationId = conversationIdArg ?? chatId;
//     if (!conversationId) return { estado: "pendiente", mensaje: "" };

//     const conversacion = (await prisma.conversation.findUnique({
//         where: { id: conversationId },
//         select: { id: true, phone: true, estado: true },
//     })) as ConversationLite | null;
//     if (!conversacion) return { estado: "pendiente", mensaje: "" };

//     const last = await prisma.message.findFirst({
//         where: { conversationId, from: MessageFrom.client },
//         orderBy: { timestamp: "desc" },
//         select: { id: true, timestamp: true, contenido: true, mediaType: true, caption: true, mediaUrl: true },
//     });

//     // — Guard: si ya está en handoff, no responder
//     let statePre = await loadState(conversationId);
//     if (conversacion?.estado === ConversationEstado.requiere_agente || statePre.handoffLocked) {
//         return { estado: "pendiente", mensaje: "" };
//     }

//     // Idempotencia de entrada
//     if (last?.id && seenInboundRecently(last.id)) return { estado: "pendiente", mensaje: "" };
//     if (last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
//         return { estado: "pendiente", mensaje: "" };
//     }

//     // Fallback de contenido si viene vacío / solo imagen
//     if (!contenido) {
//         if (last?.contenido && last.contenido.trim()) contenido = last.contenido.trim();
//         else if (last?.mediaType === MediaType.image && last?.caption) contenido = String(last.caption).trim();
//         else contenido = "…";
//     }

//     // —— Imagen del último inbound
//     const isImage = last?.mediaType === MediaType.image && !!last?.mediaUrl;
//     const imageUrl = isImage ? String(last.mediaUrl) : null;
//     const caption = String(last?.caption || "").trim();
//     const referenceTs = last?.timestamp ?? new Date();
//     if (isImage && !caption && (!contenido || contenido === "…")) {
//         await new Promise((r) => setTimeout(r, IMAGE_WAIT_MS));
//         return { estado: "pendiente", mensaje: "" };
//     }
//     if (isImage && last?.timestamp && shouldSkipDoubleReply(conversationId, last.timestamp, REPLY_DEDUP_WINDOW_MS)) {
//         return { estado: "pendiente", mensaje: "" };
//     }

//     // KB
//     const kb = await loadEsteticaKB({ empresaId });
//     // ==== LOAD EXTRA FAQs (BEGIN) ====
//     const apptCfgForFaqs = await prisma.businessConfigAppt.findUnique({
//         where: { empresaId },
//         select: { kbFAQs: true }
//     });
//     const allFaqs: Array<{ q: string; a: string }> = mergeFaqs(
//         (kb as any).faqs || (kb as any).FAQ || (kb as any).kbFAQs || [],
//         toArraySafe(apptCfgForFaqs?.kbFAQs)
//     );
//     // ==== LOAD EXTRA FAQs (END) ====
//     // === PATCH: guardar FAQs en conversation_state para futuras referencias ===
//     await patchState(conversationId, {
//         faqsCache: allFaqs,
//     });



//     if (!kb) {
//         const txt = "Por ahora no tengo la configuración de la clínica. Te comunico con un asesor humano. 🙏";
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto: txt, nuevoEstado: ConversationEstado.requiere_agente,
//             to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     // Estado + Historial + Summary
//     let state = await loadState(conversationId);
//     const history = await getRecentHistory(conversationId, undefined, CONF.MAX_HISTORY);
//     const compactContext = await buildOrReuseSummary({ empresaId, conversationId, kb, history });
//     state = await loadState(conversationId);

//     // Servicio + Intención
//     let match = resolveServiceName(kb, contenido || "");
//     if (!match.procedure) {
//         const extra = resolveBySynonyms(kb, contenido || "");
//         if (extra) match = { procedure: extra, matched: extra.name };
//     }
//     const service = match.procedure ?? (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) ?? null : null);
//     let intent = detectIntent(contenido);
//     if (intent === "other" && /servicio|tratamiento|procedimiento/i.test(contenido)) intent = "info";

//     // Modo educativo vs operativo
//     const EDUCATIONAL_MODE = isEducationalQuestion(contenido);

//     // ——— ATIENDE PREGUNTAS DE PAGO DE FORMA DETERMINÍSTICA ———
//     if (isPaymentQuestion(contenido)) {
//         const methods = readPaymentMethodsFromKB(kb);
//         if (methods.length) {
//             let texto = `Aceptamos: ${methods.join(" • ")}.`;
//             // no fuerzas agenda si el usuario solo preguntó por pagos
//             const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state: statePre });
//             texto = clampLines(closeNicely(greet.text));
//             await patchState(conversationId, { lastIntent: "info" });
//             const saved = await persistBotReply({
//                 conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
//                 to: toPhone ?? conversacion.phone, phoneNumberId,
//             });
//             if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//             return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         }
//     }


//     // ==== FAQ QUICK-ANSWER (BEGIN) ====
//     // Si hay una FAQ que responda la pregunta, respóndela de una vez
//     const faqHit = answerFromFAQs(allFaqs, contenido);
//     if (faqHit) {
//         // Añade cierre amable orientado a agenda sin sonar "bot"
//         let texto = `${faqHit}`;
//         // Pequeña cola opcional para llevar a agenda sin forzar
//         if (!shouldBypassScheduling(contenido)) {
//             texto = `${texto} ¿Quieres que te comparta *horarios* para una *valoración* y así lo dejamos reservado?`;
//         }

//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state: statePre });
//         texto = clampLines(closeNicely(greet.text));

//         await patchState(conversationId, { lastIntent: "info" });

//         const saved = await persistBotReply({
//             conversationId,
//             empresaId,
//             texto,
//             nuevoEstado: ConversationEstado.respondido,
//             to: toPhone ?? conversacion.phone,
//             phoneNumberId,
//         });

//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }
//     // ==== FAQ QUICK-ANSWER (END) ====




//     // Reagendar / Cancelar -> Handoff inmediato
//     if (intent === "reschedule" || intent === "cancel") {
//         let texto = intent === "cancel"
//             ? "Entiendo, te ayudo con la cancelación 🗓️. Dame un momento, reviso tu cita y te confirmo por aquí."
//             : "Claro, te ayudo a reprogramarla 🗓️. Dame un momento, reviso tu cita y te propongo opciones por aquí.";

//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         texto = greet.text;

//         await tagAsSchedulingNeeded({ conversationId, empresaId });
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto, nuevoEstado: ConversationEstado.requiere_agente,
//             to: toPhone ?? conversacion.phone, phoneNumberId,
//         });

//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }



//     /* ===== Agenda: colecta flexible ===== */
//     const hasDraftData =
//         !!(state.draft?.procedureId || state.draft?.procedureName ||
//             state.draft?.whenISO || state.draft?.timeHHMM ||
//             state.draft?.timeNote || state.draft?.whenText) ||
//         state.lastIntent === "schedule";



//     // Cortamos agenda si el turno actual es informativo/educativo (general)
//     const infoBreaker = shouldBypassScheduling(contenido);

//     // Solo activamos agenda cuando NO hay breaker informativo
//     const wantsSchedule =
//         !infoBreaker &&
//         (hasDraftData || detectScheduleAsk(contenido) || intent === "schedule");



//     if (wantsSchedule) {
//         const prev = state.draft ?? {};
//         const whenAsk = extractWhen(contenido);
//         // ⛔️ Dejamos de usar extractHour / extractDayPeriod para no “normalizar” hora
//         // const hourExact = extractHour(contenido);
//         // const hourPeriod = extractDayPeriod(contenido);

//         // ✅ Solo texto libre del usuario (fecha/hora tal cual)
//         const whenFree = grabWhenFreeText(contenido);
//         const nameInText = extractName(contenido);
//         const proc = service ?? (state.lastServiceId ? kb.procedures.find(p => p.id === state.lastServiceId) ?? null : null);

//         const draft: AgentState["draft"] = {
//             ...prev,
//             procedureId: prev.procedureId || (proc?.id ?? undefined),
//             procedureName: prev.procedureName || (proc?.name ?? undefined),
//             name: prev.name || nameInText || undefined,
//             // Fecha estructurada solo si viene (para mostrar día de semana si aplica),
//             // pero sin forzar hora.
//             whenISO: prev.whenISO || whenAsk?.iso || undefined,

//             // ⛔️ No poblamos timeHHMM ni timeNote para no calcular hora
//             // timeHHMM: prev.timeHHMM || hourExact || undefined,
//             // timeNote: prev.timeNote || hourPeriod || undefined,

//             // ✅ Guardamos lo que el cliente escribió (fecha/hora/franja textual)
//             whenText: prev.whenText || whenFree || undefined,
//         };


//         await patchState(conversationId, { lastIntent: "schedule", draft });

//         const hasProcedure = !!(draft.procedureId || draft.procedureName);
//         const hasName = !!draft.name;
//         const hasDate = hasSomeDate(draft);

//         if (hasProcedure && hasName && hasDate) {
//             const fechaDet = draft.whenISO
//                 ? new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })
//                     .format(new Date(draft.whenISO))
//                 : null;

//             const preferencia = draft.whenText
//                 ? draft.whenText
//                 : (fechaDet || "recibida");


//             const piezas = [
//                 `Tratamiento: *${draft.procedureName ?? "—"}*`,
//                 `Nombre: *${draft.name}*`,
//                 `Preferencia: *${preferencia}*`
//             ].join(" · ");

//             let texto = `¡Perfecto! ⏱️ Dame *unos minutos* para *verificar disponibilidad* 🗓️ y te *confirmo por aquí* ✅.\n${piezas}`;

//             await tagAsSchedulingNeeded({ conversationId, empresaId });

//             const saved = await persistBotReply({
//                 conversationId,
//                 empresaId,
//                 texto: clampLines(texto),
//                 nuevoEstado: ConversationEstado.requiere_agente,
//                 to: toPhone ?? conversacion.phone,
//                 phoneNumberId,
//             });
//             if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//             return { estado: "requiere_agente", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         }

//         const asks: string[] = [];
//         if (!hasProcedure) asks.push("¿Para qué *tratamiento* deseas la cita?");
//         if (!hasDate) asks.push("¿Qué *día y hora* prefieres? (texto libre, ej.: “martes en la tarde” o “15/11 a las 3 pm”).");

//         if (!hasName) asks.push("¿Cuál es tu *nombre completo*?");

//         const texto = clampLines(closeNicely(asks.join(" ")));
//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto: greet.text,
//             nuevoEstado: ConversationEstado.respondido,
//             to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }



//     /* ===== UBICACIÓN ===== */
//     const isLocation = /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde\s+est[áa]n|mapa|c[oó]mo\s+llego|como\s+llego|sede|ubicados?)\b/i.test(contenido);
//     if (isLocation) {
//         const loc = (kb.location ?? {}) as any;
//         const lines: string[] = [];
//         if (loc.name) lines.push(`Estamos en nuestra sede *${String(loc.name)}*.`);
//         const addrParts = [loc.address, loc.address2, loc.reference].filter(Boolean).map((s: unknown) => String(s).trim());
//         if (addrParts.length) lines.push(addrParts.join(", "));
//         if (loc.mapsUrl) lines.push(`Mapa: ${String(loc.mapsUrl)}`);
//         const arrival = loc.arrivalInstructions ?? loc.instructions;
//         if (loc.parkingInfo) lines.push(`Parqueadero: ${String(loc.parkingInfo)}`);
//         if (arrival) lines.push(`Indicaciones: ${String(arrival)}`);

//         let texto = lines.length ? lines.join("\n") : "Estamos ubicados en nuestra sede principal. 😊";
//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         texto = greet.text;
//         if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//         await patchState(conversationId, { lastIntent: "info" });
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto: clampLines(closeNicely(texto)),
//             nuevoEstado: ConversationEstado.respondido, to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }


//     /* ===== Quién realiza ===== */
//     if (/\b(qu[ié]n|quien|persona|profesional|doctor|doctora|m[eé]dico|esteticista).*(hace|realiza|atiende|me va a hacer)\b/i.test(contenido)) {
//         const whoProc = service || (state.lastServiceId ? kb.procedures.find((p) => p.id === state.lastServiceId) : null);
//         const staff = pickStaffForProcedure(kb, whoProc || undefined);
//         const labelSvc = whoProc?.name ? `*${whoProc.name}* ` : "";
//         let texto = staff
//             ? `${labelSvc}lo realiza ${staff.role === "medico" ? "la/el Dr(a)." : ""} *${staff.name}*. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Quieres ver horarios?`
//             : `${labelSvc}lo realiza un profesional de nuestro equipo. Antes hacemos una valoración breve para personalizar el tratamiento. ¿Te paso horarios?`;

//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         texto = greet.text;
//         if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//         await patchState(conversationId, {
//             // Cambiamos a 'schedule' porque el propio mensaje invita a ver horarios
//             lastIntent: "schedule",
//             ...(whoProc ? { lastServiceId: whoProc.id, lastServiceName: whoProc.name } : {}),
//         });

//         const saved = await persistBotReply({
//             conversationId, empresaId, texto: clampLines(closeNicely(texto)),
//             nuevoEstado: ConversationEstado.en_proceso, to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     /* ===== ¿Qué servicios ofrecen? ===== */
//     if (/que\s+servicios|qué\s+servicios|servicios\s+ofreces?/i.test(contenido)) {
//         const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
//         const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
//         const items = kb.procedures.slice(0, 6).map((p) => {
//             const desde = p.priceMin ? ` (desde ${formatCOP(p.priceMin)})` : "";
//             return `• ${p.name}${desde}`;
//         }).join("\n");

//         let texto = clampLines(closeNicely(
//             `${items}\n\nSi alguno te interesa, dime el *día y hora* que prefieres agendar${human ? ` (trabajamos: ${human}${sufijoUltima})` : ""}.`
//         ));
//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         texto = greet.text;
//         if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//         await patchState(conversationId, { lastIntent: "schedule" });
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     /* ===== “Precio exacto según mi caso” ===== */
//     if (detectExactPriceQuery(contenido)) {
//         const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
//         const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
//         let texto = `El *precio exacto* se confirma en la *valoración presencial* antes del procedimiento. 💡 Si te parece, dime el *día y hora* que prefieres (trabajamos: ${human}${sufijoUltima}) y luego tu *nombre completo* para reservar.`;
//         const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//         texto = greet.text;
//         if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//         await patchState(conversationId, { lastIntent: "schedule" });
//         const saved = await persistBotReply({
//             conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
//             to: toPhone ?? conversacion.phone, phoneNumberId,
//         });
//         if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//         return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//     }

//     /* ===== Precio – catálogo (DESDE) ===== */
//     if (detectIntent(contenido) === "price") {
//         if (service) {
//             const priceLabel = service.priceMin ? `Desde ${formatCOP(service.priceMin)} (COP)` : null;
//             const dur = service.durationMin ?? kb.defaultServiceDurationMin ?? 60;
//             const staff = pickStaffForProcedure(kb, service);
//             const piezas = [
//                 `${varyPrefix("offer")} *${service.name}*`,
//                 priceLabel ? `💵 ${priceLabel}` : "",
//                 `⏱️ Aprox. ${dur} min`,
//                 staff ? `👩‍⚕️ Profesional: ${staff.name}` : "",
//             ].filter(Boolean);
//             let texto = clampLines(closeNicely(`${piezas.join(" · ")}\n\n¿Quieres ver horarios cercanos? 🗓️`));

//             const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//             texto = greet.text;
//             if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//             await patchState(conversationId, {
//                 // Preguntamos por horarios ⇒ forzamos modo agenda "pegadizo"
//                 lastIntent: "schedule",
//                 lastServiceId: service.id,
//                 lastServiceName: service.name
//             });

//             const saved = await persistBotReply({
//                 conversationId, empresaId, texto, nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone, phoneNumberId,
//             });
//             if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//             return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         } else {
//             const { human, lastStart } = await buildBusinessRangesHuman(empresaId, kb);
//             const sufijoUltima = lastStart ? `; última cita de referencia ${lastStart}` : "";
//             const nombres = kb.procedures.slice(0, 3).map((s) => s.name).join(", ");
//             let ask = `Manejo los *precios de catálogo* (valores “desde”). ¿De cuál tratamiento te paso precio? (Ej.: ${nombres}). Si ya sabes cuál, dime también el *día y hora* que prefieres (trabajamos: ${human}${sufijoUltima}).`;

//             const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: ask, state });
//             ask = greet.text;
//             if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//             await patchState(conversationId, { lastIntent: "schedule" });

//             const saved = await persistBotReply({
//                 conversationId, empresaId, texto: ask, nuevoEstado: ConversationEstado.en_proceso,
//                 to: toPhone ?? conversacion.phone, phoneNumberId,
//             });
//             if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//             return { estado: "en_proceso", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
//         }
//     }

//     // — Cortafuegos antes de respuesta libre
//     {
//         const conversacionNow = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { estado: true } });
//         const stateNow = await loadState(conversationId);
//         if (conversacionNow?.estado === ConversationEstado.requiere_agente || stateNow.handoffLocked) {
//             return { estado: "pendiente", mensaje: "" };
//         }
//     }

//     /* ===== Respuesta libre con contexto ===== */
//     const system = [
//         `Eres asesor de una clínica estética (${kb.timezone}).`,
//         `MODOS DE RESPUESTA (OBLIGATORIO CUMPLIR):
//      • MODO OPERATIVO: usa EXCLUSIVAMENTE datos de BD/KB (horarios, precios "desde", staff, ubicación, medios de pago, políticas, disponibilidad). Si el usuario pide algo NO registrado (p. ej. “Addi”), responde: "No me aparece en nuestro catálogo" y ofrece solo lo que SÍ está en BD/KB.
//      • MODO EDUCATIVO: puedes dar explicaciones generales (qué es, cómo actúa, beneficios, cuidados, consideraciones) sin diagnosticar, sin prometer resultados, sin confirmar precios exactos ni promociones y sin afirmar que ofrecemos algo si no está en BD/KB. Cierra invitando a *valoración presencial* para personalizar y confirmar detalles.
//      • Si no hay datos suficientes en BD/KB para un punto operativo, dilo explícitamente y deriva a valoración para confirmación precisa.`,
//         `No inventes marcas, métodos de pago, promociones ni servicios. No confirmes disponibilidad específica. Precios SOLO "desde" si figura en KB.
//      En el primer mensaje puedes saludar; luego no repitas saludos. Responde breve (2–5 líneas, 0–2 emojis).`,
//         `Resumen operativo (OBLIGATORIO LEER Y RESPETAR):\n${compactContext}`,
//     ].join("\n");

//     const userCtx = [
//         `MODO: ${EDUCATIONAL_MODE ? "educativo" : "operativo"}`,
//         service ? `Servicio en contexto: ${service.name}` : state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : "",
//         `Usuario: ${contenido}`,
//     ].filter(Boolean).join("\n");

//     const dialogMsgs = history.slice(-6).map((h) => ({ role: h.role, content: h.content }));

//     let effectiveImageUrl = imageUrl;
//     let contenidoConNota = contenido;
//     if (!effectiveImageUrl && contenido) {
//         const picked = await pickImageForContext({
//             conversationId, directUrl: null, userText: contenido, caption, referenceTs,
//         });
//         effectiveImageUrl = picked.url;
//         if (picked.noteToAppend) contenidoConNota = `${contenido}${picked.noteToAppend}`;
//     }

//     const messages: any[] = [{ role: "system", content: system }, ...dialogMsgs];
//     if (effectiveImageUrl) {
//         messages.push({
//             role: "user",
//             content: [
//                 {
//                     type: "text", text: [
//                         `MODO: ${EDUCATIONAL_MODE ? "educativo" : "operativo"}`,
//                         (service ? `Servicio en contexto: ${service.name}` : (state.lastServiceName ? `Servicio en contexto: ${state.lastServiceName}` : "")),
//                         `Usuario: ${contenidoConNota}`
//                     ].filter(Boolean).join("\n")
//                 },
//                 { type: "image_url", image_url: { url: effectiveImageUrl } },
//             ],
//         });
//     } else {
//         messages.push({ role: "user", content: userCtx });
//     }

//     let texto = "";
//     try {
//         const resp: any =
//             (openai as any).chat?.completions?.create
//                 ? await (openai as any).chat.completions.create({ model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190, messages })
//                 : await (openai as any).createChatCompletion({ model: CONF.MODEL, temperature: CONF.TEMPERATURE, max_tokens: 190, messages });
//         texto = (resp?.choices?.[0]?.message?.content || "").trim();
//     } catch {
//         texto = "Puedo ayudarte con tratamientos faciales (limpieza, peeling, toxina botulínica). ¿Sobre cuál quieres info?";
//     }

//     // —— Postfiltro de seguridad educativa (solo si es modo educativo)
//     if (EDUCATIONAL_MODE) {
//         const safeTail = " Para una recomendación personalizada y confirmar detalles, hacemos una *valoración presencial* con el equipo.";
//         texto = texto.replace(/\b(garantiza(?:mos)?|asegura(?:mos)?|sin\s*riesgo|resultados?\s*100%)/gi, "");
//         if (!/[.!?…]$/.test(texto.trim())) texto = texto.trim() + ".";
//         if (!/valoraci[oó]n/i.test(texto)) texto = texto + safeTail;
//     }

//     // Limpiamos mensajes peligrosos sobre "no tengo acceso a la agenda"
//     {
//         const san = sanitizeNoAccessAgenda(texto);
//         texto = san.text;
//     }

//     // Si el propio bot invita a agenda en este texto, marcamos la intención como 'schedule' (modo pegadizo)
//     if (isSchedulingCue(texto)) {
//         await patchState(conversationId, { lastIntent: "schedule" });
//     }


//     texto = clampLines(closeNicely(texto));
//     const greet = await maybePrependGreeting({ conversationId, kbName: kb.businessName, text: texto, state });
//     texto = greet.text;
//     if (greet.greetedNow) await patchState(conversationId, { greeted: true });

//     {
//         const detected = detectIntent(contenido);
//         const latest = (await loadState(conversationId)).lastIntent;

//         // Si este turno fue informativo, no dejamos “pegado” schedule
//         const nextIntent =
//             shouldBypassScheduling(contenido)
//                 ? "info"
//                 : (latest === "schedule" || detected === "schedule" ? "schedule"
//                     : (detected === "other" ? state.lastIntent : detected));

//         await patchState(conversationId, {
//             lastIntent: nextIntent,
//             ...(service ? { lastServiceId: service.id, lastServiceName: service.name } : {}),
//         });
//     }



//     const saved = await persistBotReply({
//         conversationId, empresaId, texto, nuevoEstado: ConversationEstado.respondido,
//         to: toPhone ?? conversacion.phone, phoneNumberId,
//     });
//     if (last?.timestamp) markActuallyReplied(conversationId, last.timestamp);
//     return { estado: "respondido", mensaje: saved.texto, messageId: saved.messageId, wamid: saved.wamid, media: [] };
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

    // ==== Normalizar FAQs (acepta array de {q,a}, array de strings, o objeto mapa) ====
    type FAQ = { q: string; a: string };
    function toFaqArray(src: any): FAQ[] {
        if (!src) return [];
        if (Array.isArray(src)) {
            if (src.length && typeof src[0] === "string") {
                // ["¿Qué es X?|Respuesta...", ...]
                return src
                    .map((s: string) => {
                        const [q, a] = String(s).split("|");
                        return { q: (q || "").trim(), a: (a || "").trim() };
                    })
                    .filter(f => f.q && f.a);
            }
            if (src.length && typeof src[0] === "object") {
                // [{ q, a }, ...]
                return src
                    .map((o: any) => ({ q: String(o?.q || "").trim(), a: String(o?.a || "").trim() }))
                    .filter(f => f.q && f.a);
            }
        }
        if (typeof src === "object") {
            // { "¿Pregunta?": "Respuesta", ... }
            return Object.entries(src)
                .map(([q, a]) => ({ q: String(q).trim(), a: String(a ?? "").trim() }))
                .filter(f => f.q && f.a);
        }
        if (typeof src === "string") {
            // Bloque de texto "P|R\nP|R..."
            return src
                .split(/\r?\n/)
                .map(l => {
                    const [q, a] = l.split("|");
                    return { q: (q || "").trim(), a: (a || "").trim() };
                })
                .filter(f => f.q && f.a);
        }
        return [];
    }

    const faqsArr = toFaqArray(S.kbFAQs);
    const faqsLine = faqsArr.length
        ? "FAQs: " +
        faqsArr
            .slice(0, 5) // solo las 5 más relevantes/primeras
            .map(f => `${softTrim(f.q, 60)} → ${softTrim(f.a, 120)}`)
            .join(" | ")
        : "";


    const base = [
        kb.businessName ? `Negocio: ${kb.businessName}` : "Negocio: Clínica estética",
        `Zona horaria: ${S.appointmentTimezone || kb.timezone}`,
        `Agenda: ${S.appointmentEnabled ? "habilitada" : "deshabilitada"} | Buffer ${S.appointmentBufferMin ?? kb.bufferMin ?? "-"} min`,
        `Reglas: ${[
            S.allowSameDayBooking != null ? `mismo día ${S.allowSameDayBooking ? "sí" : "no"}` : "",
            S.appointmentMinNoticeHours != null ? `anticipación ${S.appointmentMinNoticeHours} h` : "",
            S.appointmentMaxAdvanceDays != null ? `hasta ${S.appointmentMaxAdvanceDays} días` : "",
        ].filter(Boolean).join(" | ")}`,
        `Logística: ${[
            S.locationName ? `Sede ${S.locationName}` : "",
            S.locationAddress ? `Dir. ${S.locationAddress}` : "",
            S.locationMapsUrl ? `Mapa ${S.locationMapsUrl}` : "",
            S.parkingInfo ? `Parqueadero ${softTrim(S.parkingInfo, 120)}` : "",
            S.instructionsArrival ? `Indicaciones ${softTrim(S.instructionsArrival, 120)}` : "",
        ].filter(Boolean).join(" | ")}`,
        (S.noShowPolicy || S.depositRequired != null)
            ? `Políticas: ${[
                S.noShowPolicy ? `No-show ${softTrim(S.noShowPolicy, 120)}` : "",
                S.depositRequired ? `Depósito ${S.depositAmount ? formatCOP(Number(S.depositAmount)) : "sí"}` : "Depósito no",
            ].filter(Boolean).join(" | ")}`
            : "",
        paymentsLine,
        `Servicios (KB): ${svcFromKB || "—"}`,
        hoursLine ? `Horario base (DB): ${hoursLine}${lastStart ? `; última cita de referencia ${lastStart}` : ""}` : "",
        exceptionsLine,
        faqsLine,
        S.kbBusinessOverview ? `Overview: ${softTrim(S.kbBusinessOverview, 260)}` : "",
        S.kbFreeText ? `Notas: ${softTrim(S.kbFreeText, 260)}` : "",
        `Historial breve: ${history || "—"}`,
    ].filter(Boolean).join("\n");

    // Compacto (pero incluyendo TODO en el prompt):
    // Compacto (pero incluyendo TODO en el prompt) + FAQs garantizadas
    let compact = base;
    try {
        const resp = await openai.chat.completions.create({
            model: CONF.MODEL,
            temperature: 0.1,
            max_tokens: 300,
            messages: [
                { role: "system", content: "Resume en 400–700 caracteres, bullets cortos y datos operativos. NO omitas la sección de FAQs si está disponible." },
                { role: "user", content: base.slice(0, 4000) },
            ],
        });
        compact = (resp?.choices?.[0]?.message?.content || base).trim().replace(/\n{3,}/g, "\n\n");
    } catch {
        // Dejar base si falla
    }

    // Asegurar FAQs explícitas al final del summary
    const faqsBlock = faqsArr.length
        ? "\nFAQs:\n- " + faqsArr.slice(0, 5).map(f => `${softTrim(f.q, 60)} → ${softTrim(f.a, 140)}`).join("\n- ")
        : "";

    compact = (compact + faqsBlock).trim();


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
        // evita capturar palabras típicas de agenda
        if (/\b(viernes|sábado|sabado|lunes|martes|miércoles|miercoles|jueves|hoy|mañana|manana)\b/i.test(name)) return null;
        if (/\b(botox|toxina|peeling|limpieza|relleno|hialuronico|hialurónico)\b/i.test(name)) return null;
        return name;
    }

    // Sin disparador, NO asumir nombre (elimina falsos positivos tipo “Botox para este viernes”)
    return null;
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

/** Un solo emoji “estable” por conversación (misma conversación → mismo emoji) */
function addEmojiStable(text: string, conversationId: number) {
    const base = (Number.isFinite(conversationId) ? conversationId : 0) >>> 0;
    const emojis = ["🙂", "💬", "✨", "👌", "🫶"];
    const idx = base % emojis.length;
    // Si ya trae uno de estos emojis, no agregues otro
    if (/[🙂💬✨👌🫶]/.test(text)) return text;
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
        "Tono humano, cálido y breve. Saludo corto, sin información extra.",
        "Usa como máximo un emoji natural.",
        "No des precios exactos; usa 'desde' si existe priceMin.",
        "No infieras horas: si el cliente escribe la hora, repítela textual; no calcules.",
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
        max_tokens: 120,
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
        const saved = await persistBotReply({
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
    const nameInText = extractName(userText);
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
        const piezas = [
            `Tratamiento: *${newDraft.procedureName ?? "—"}*`,
            `Nombre: *${newDraft.name}*`,
            newDraft.whenText ? `Preferencia: *${newDraft.whenText}*` : (newDraft.whenISO ? `Fecha: *${new Date(newDraft.whenISO).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}*` : "")
        ].filter(Boolean).join(" · ");

        const msg = `¡Perfecto! Dame *unos minutos* para *verificar disponibilidad* 🗓️ y te *confirmo por aquí* ✅.\n${piezas}`;
        const saved = await persistBotReply({
            conversationId: chatId,
            empresaId,
            texto: clampText(msg),
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
        const saved = await persistBotReply({
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
    // ——— Respuesta directa a “qué servicios” (sin matar la conversación ni forzar agenda)
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

        const saved = await persistBotReply({
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

    // ===== Si aún faltan piezas para agenda, pedimos solo lo que falta (sin forzar hora)
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

        const saved = await persistBotReply({
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
    texto = clampText(texto || "¡Hola! ¿Prefieres info de tratamientos o ver opciones para agendar?");
    texto = addEmojiStable(texto, chatId);


    const saved = await persistBotReply({
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

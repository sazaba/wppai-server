// // utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
// import prisma from "../../../../../lib/prisma";
// import {
//     addDays,
//     addMinutes,
//     endOfDay,
//     max as dfMax,
//     startOfDay,
// } from "date-fns";
// import {
//     format as tzFormat,
//     utcToZonedTime,
//     zonedTimeToUtc,
// } from "date-fns-tz";
// import type {
//     AppointmentSource,
//     AppointmentStatus,
//     AppointmentVertical,
//     Weekday,
// } from "@prisma/client";

// /* ============================================================
//    Tipos públicos (consumidos por estetica.strategy)
// ============================================================ */
// export type Slot = { startISO: string; endISO: string };
// export type SlotsByDay = { dateISO: string; slots: Slot[] };

// export type KBMinimal = {
//     vertical: AppointmentVertical | "custom";
//     timezone: string;
//     bufferMin?: number | null;
//     defaultServiceDurationMin?: number | null;
//     procedures: Array<{
//         id: number;
//         name: string;
//         durationMin?: number | null;
//     }>;
// };

// export type DraftStage = "idle" | "offer" | "confirm";
// export type SchedulingDraft = {
//     name?: string;
//     phone?: string;
//     procedureId?: number;
//     procedureName?: string;
//     whenISO?: string;
//     durationMin?: number;
//     stage?: DraftStage;
//     // reagendamiento
//     rescheduleApptId?: number;
// };

// export type StateShape = {
//     draft?: SchedulingDraft;
//     lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
//     lastServiceId?: number | null;
//     lastServiceName?: string | null;
//     slotsCache?: {
//         items: Array<{ startISO: string; endISO: string; label: string }>;
//         expiresAt: string;
//     };
//     lastPhoneSeen?: string | null;
// };

// export type SchedulingCtx = {
//     empresaId: number;
//     kb: KBMinimal;
//     granularityMin: number;
//     daysHorizon: number;
//     maxSlots: number;
//     now?: Date;
//     toCOP?: (v?: number | null) => string | null;
// };

// export type SchedulingResult = {
//     handled: boolean;
//     reply?: string;
//     patch?: Partial<StateShape>;
//     createOk?: boolean;
//     needsHuman?: boolean;
//     failMessage?: string;
// };

// /* ============================================================
//    Utils de TZ y tiempo
// ============================================================ */
// const WEEKDAY_ORDER: Record<Weekday, number> = {
//     mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
// };

// function getWeekdayFromDate(dLocal: Date): Weekday {
//     const dow = dLocal.getDay(); // 0..6
//     return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] || "mon") as Weekday;
// }

// function hhmmToUtc(dayLocalISO: string, hhmm: string, tz: string): Date {
//     const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
//     const localBase = utcToZonedTime(zonedTimeToUtc(dayLocalISO, tz), tz);
//     localBase.setHours(h, m, 0, 0);
//     return zonedTimeToUtc(localBase, tz);
// }

// function roundUpToGranularity(date: Date, granMin: number): Date {
//     const step = granMin * 60_000;
//     return new Date(Math.ceil(date.getTime() / step) * step);
// }

// const iso = (d: Date) => new Date(d.getTime()).toISOString();
// const intervalsOverlap = (aS: Date, aE: Date, bS: Date, bE: Date) => aS < bE && bS < aE;

// function formatAmPm(d: Date) {
//     let h = d.getHours();
//     const m = d.getMinutes();
//     const ampm = h >= 12 ? "pm" : "am";
//     h = h % 12; h = h ? h : 12;
//     const mm = m.toString().padStart(2, "0");
//     return `${h}:${mm} ${ampm}`;
// }

// function nowPlusMin(min: number) {
//     return new Date(Date.now() + min * 60_000).toISOString();
// }

// /* ============================================================
//    Construcción de ventanas (AppointmentHour + Exception)
// ============================================================ */
// async function getOpenWindowsForDate(params: {
//     empresaId: number;
//     dateLocal: Date;
//     tz: string;
// }) {
//     const { empresaId, dateLocal, tz } = params;
//     const weekday = getWeekdayFromDate(dateLocal);

//     const base = await prisma.appointmentHour.findUnique({
//         where: { empresaId_day: { empresaId, day: weekday } },
//     });

//     // excepción del día (rango local 00:00–23:59)
//     const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", { timeZone: tz });
//     const startLocal = utcToZonedTime(zonedTimeToUtc(dayISO, tz), tz);
//     const endLocal = utcToZonedTime(
//         zonedTimeToUtc(tzFormat(dateLocal, "yyyy-MM-dd'T'23:59:59", { timeZone: tz }), tz),
//         tz
//     );

//     const exception = await prisma.appointmentException.findFirst({
//         where: {
//             empresaId,
//             date: {
//                 gte: zonedTimeToUtc(startLocal, tz),
//                 lte: zonedTimeToUtc(endLocal, tz),
//             },
//         },
//     });

//     const open =
//         exception?.isOpen === false
//             ? []
//             : [
//                 { start: exception?.start1 ?? base?.start1 ?? null, end: exception?.end1 ?? base?.end1 ?? null },
//                 { start: exception?.start2 ?? base?.start2 ?? null, end: exception?.end2 ?? base?.end2 ?? null },
//             ].filter((w) => w.start && w.end) as Array<{ start: string; end: string }>;

//     return open.map(({ start, end }) => {
//         const s = hhmmToUtc(dayISO, start, tz);
//         const e = hhmmToUtc(dayISO, end, tz);
//         return { startUtc: s, endUtc: e };
//     });
// }

// /* ============================================================
//    Ocupados del día (Appointment en estados que bloquean)
// ============================================================ */
// async function getBusyIntervalsUTC(params: {
//     empresaId: number;
//     dayStartUtc: Date;
//     dayEndUtc: Date;
// }) {
//     const { empresaId, dayStartUtc, dayEndUtc } = params;
//     const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
//     const appts = await prisma.appointment.findMany({
//         where: {
//             empresaId,
//             deletedAt: null,
//             status: { in: blocking },
//             OR: [{ startAt: { lt: dayEndUtc }, endAt: { gt: dayStartUtc } }],
//         },
//         select: { startAt: true, endAt: true },
//     });
//     return appts.map((a) => ({ startUtc: a.startAt, endUtc: a.endAt }));
// }

// /* ============================================================
//    Generación de slots
// ============================================================ */
// function carveSlotsFromWindows(params: {
//     windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
//     busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
//     durationMin: number;
//     granMin: number;
//     earliestAllowedUtc: Date;
//     maxPerDay: number;
// }): Slot[] {
//     const { windowsUtc, busyUtc, durationMin, granMin, earliestAllowedUtc, maxPerDay } = params;

//     const slots: Slot[] = [];
//     for (const w of windowsUtc) {
//         let cursor = roundUpToGranularity(dfMax([w.startUtc, earliestAllowedUtc]), granMin);
//         while (true) {
//             const end = addMinutes(cursor, durationMin);
//             if (end > w.endUtc) break;

//             const overlaps = busyUtc.some((b) => intervalsOverlap(cursor, end, b.startUtc, b.endUtc));
//             if (!overlaps) {
//                 slots.push({ startISO: iso(cursor), endISO: iso(end) });
//                 if (slots.length >= maxPerDay) break;
//             }

//             cursor = addMinutes(cursor, granMin);
//             if (cursor >= w.endUtc) break;
//         }
//         if (slots.length >= maxPerDay) break;
//     }
//     return slots;
// }

// /* ============================================================
//    API pública: slots disponibles
// ============================================================ */
// export async function getNextAvailableSlots(
//     env: {
//         empresaId: number;
//         timezone: string;
//         vertical: AppointmentVertical | "custom";
//         bufferMin?: number | null;
//         granularityMin: number;
//     },
//     fromDateISO: string,
//     durationMin: number,
//     daysHorizon: number,
//     maxPerDay: number
// ): Promise<SlotsByDay[]> {
//     const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

//     const baseLocalDate = utcToZonedTime(new Date(fromDateISO + "T00:00:00Z"), tz);
//     const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

//     const results: SlotsByDay[] = [];
//     for (let i = 0; i < daysHorizon; i++) {
//         const dayLocal = addDays(baseLocalDate, i);
//         const dayStartUtc = zonedTimeToUtc(startOfDay(dayLocal), tz);
//         const dayEndUtc = zonedTimeToUtc(endOfDay(dayLocal), tz);

//         const windowsUtc = await getOpenWindowsForDate({ empresaId, dateLocal: dayLocal, tz });

//         if (!windowsUtc.length) {
//             results.push({ dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }), slots: [] });
//             continue;
//         }

//         const busyUtc = await getBusyIntervalsUTC({ empresaId, dayStartUtc, dayEndUtc });

//         const slots = carveSlotsFromWindows({
//             windowsUtc,
//             busyUtc,
//             durationMin,
//             granMin: granularityMin,
//             earliestAllowedUtc,
//             maxPerDay,
//         });

//         results.push({ dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }), slots });
//     }

//     return results;
// }

// /* ============================================================
//    Crear cita segura (Prisma directo)
// ============================================================ */
// export async function createAppointmentSafe(args: {
//     empresaId: number;
//     vertical: AppointmentVertical | "custom";
//     timezone: string;
//     procedureId?: number | null;
//     serviceName: string;
//     customerName: string;
//     customerPhone: string;
//     startISO: string; // UTC ISO
//     endISO: string;   // UTC ISO
//     notes?: string;
//     source?: "ai" | "web" | "manual" | "client";
// }) {
//     const {
//         empresaId,
//         procedureId,
//         serviceName,
//         customerName,
//         customerPhone,
//         startISO,
//         endISO,
//         notes,
//         source,
//         timezone,
//     } = args;

//     const startAt = new Date(startISO);
//     const endAt = new Date(endISO);

//     // 1) overlap rápido
//     const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
//     const overlap = await prisma.appointment.findFirst({
//         where: {
//             empresaId,
//             deletedAt: null,
//             status: { in: blocking },
//             OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
//         },
//         select: { id: true },
//     });
//     if (overlap) throw new Error("OVERLAP");

//     // 2) fuente segura (evita crash si enum no tiene "ai")
//     const SOURCE_MAP: Record<string, AppointmentSource> = {
//         ai: "client" as AppointmentSource,
//         web: "web" as AppointmentSource,
//         manual: "manual" as AppointmentSource,
//         client: "client" as AppointmentSource,
//     };
//     const safeSource: AppointmentSource = SOURCE_MAP[source || "client"];

//     // 3) create alineado al controller
//     try {
//         const created = await prisma.appointment.create({
//             data: {
//                 empresaId,
//                 procedureId: procedureId ?? null,
//                 serviceName,
//                 customerName,
//                 customerPhone,
//                 startAt,
//                 endAt,
//                 status: "confirmed",
//                 source: safeSource,
//                 notas: notes ?? null,
//                 timezone: timezone || "America/Bogota",
//                 customerDisplayName: customerName,
//                 serviceDurationMin: Math.max(
//                     1,
//                     Math.round((endAt.getTime() - startAt.getTime()) / 60000)
//                 ),
//                 locationNameCache: null,
//             },
//         });
//         return { ok: true, id: created.id };
//     } catch (e) {
//         console.error("[createAppointmentSafe] ❌", e);
//         throw e;
//     }
// }

// /* ============================================================
//    Helpers de UX (labels y parsing de hora)
// ============================================================ */
// function labelSlotsForTZ(slots: Slot[], tz: string) {
//     return slots.map((s) => {
//         const d = utcToZonedTime(new Date(s.startISO), tz);
//         const dia = d.toLocaleDateString("es-CO", {
//             weekday: "long",
//             day: "2-digit",
//             month: "short",
//             timeZone: tz,
//         });
//         const label = `${dia}, ${formatAmPm(d)}`; // ej: lunes, 13 oct, 2:30 pm
//         return { startISO: s.startISO, endISO: s.endISO, label };
//     });
// }

// // Capturas
// const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
// const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/;   // 7–12 dígitos
// const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/; // 24h
// const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i; // 12h

// function properCase(v?: string) {
//     return (v || "")
//         .trim()
//         .replace(/\s+/g, " ")
//         // @ts-ignore: Unicode property escapes
//         .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
// }

// function normalizePhone(raw?: string): string | undefined {
//     if (!raw) return undefined;
//     const digits = raw.replace(/\D+/g, "");
//     if (!digits) return undefined;
//     return digits.length >= 10 ? digits.slice(-10) : digits;
// }

// /** Extrae HH:MM local en minutos desde 00:00 (acepta 14:30 o 2:30 pm). */
// function extractLocalMinutesFromText(text: string): number | null {
//     const m12 = AMPM_RE.exec(text);
//     if (m12) {
//         let h = parseInt(m12[1], 10);
//         const minutes = m12[2] ? parseInt(m12[2], 10) : 0;
//         const ampm = m12[3].toLowerCase();
//         if (h === 12) h = 0;
//         if (ampm === "pm") h += 12;
//         return h * 60 + minutes;
//     }
//     const m24 = HHMM_RE.exec(text);
//     if (m24) {
//         const h = parseInt(m24[1], 10);
//         const minutes = parseInt(m24[2], 10);
//         return h * 60 + minutes;
//     }
//     return null;
// }

// /** Franja del día pedida por texto. */
// type DayPeriod = "morning" | "afternoon" | "evening";
// function parseDayPeriod(text: string): DayPeriod | null {
//     const t = text.toLowerCase();
//     if (/\b(mañana|manana|temprano|a primera hora)\b/.test(t)) return "morning";
//     if (/\b(tarde|after\s*noon)\b/.test(t)) return "afternoon";
//     if (/\b(noche|tarde-noche|tarde noche|evening)\b/.test(t)) return "evening";
//     return null;
// }
// function inPeriod(d: Date, period: DayPeriod): boolean {
//     const h = d.getHours();
//     if (period === "morning") return h >= 6 && h < 12;
//     if (period === "afternoon") return h >= 12 && h < 18;
//     return h >= 18 && h <= 21;
// }

// /** Match en slotsCache por minutos locales del inicio. */
// // genérico para respetar el tipo (con/sin label)
// function findSlotByLocalMinutes<T extends { startISO: string; endISO: string }>(
//     items: T[],
//     tz: string,
//     targetMin: number
// ): T | undefined {
//     return items.find((s) => {
//         const d = utcToZonedTime(new Date(s.startISO), tz);
//         const mm = d.getHours() * 60 + d.getMinutes();
//         return mm === targetMin;
//     });
// }

// async function findUpcomingApptByPhone(empresaId: number, phone: string) {
//     const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
//     return prisma.appointment.findFirst({
//         where: {
//             empresaId,
//             customerPhone: { contains: phone },
//             status: { in: blocking },
//             startAt: { gte: new Date() },
//         },
//         orderBy: { startAt: "asc" },
//     });
// }

// /* ============================================================
//    Orquestador de turno (schedule + cancel + reschedule)
// ============================================================ */
// export async function handleSchedulingTurn(params: {
//     text: string;
//     state: StateShape;
//     ctx: SchedulingCtx;
//     serviceInContext?: { id: number; name: string; durationMin?: number | null } | null;
//     intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
// }): Promise<SchedulingResult> {
//     const { text, state, ctx, serviceInContext, intent } = params;
//     const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
//     const tz = kb.timezone;

//     // señales de intención
//     const wantsCancel = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i.test(text);
//     const wantsReschedule = /\b(reagendar|reprogramar|cambiar\s+hora|otro\s+horario|mover\s+cita)\b/i.test(text);

//     // capturas
//     const nameMatch = NAME_RE.exec(text);
//     const phoneMatch = PHONE_ANY_RE.exec(text);
//     const capturedName = nameMatch ? properCase(nameMatch[2]) : undefined;
//     const capturedPhone = normalizePhone(phoneMatch?.[2]);

//     // memoria corta de teléfono
//     const basePatch: Partial<StateShape> = {};
//     if (capturedPhone) basePatch.lastPhoneSeen = capturedPhone;

//     const inDraft = state.draft?.stage === "offer" || state.draft?.stage === "confirm";

//     // === Cancelar
//     if (intent === "cancel" || wantsCancel) {
//         const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
//         if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };

//         const appt = await findUpcomingApptByPhone(empresaId, phone);
//         if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };

//         await prisma.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
//         return { handled: true, reply: "Listo, tu cita fue *cancelada*. Si deseas, te muestro nuevos horarios.", patch: { draft: { stage: "idle" }, lastIntent: "cancel", ...basePatch } };
//     }

//     // === Reagendar
//     if (intent === "reschedule" || wantsReschedule) {
//         const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
//         if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };

//         const appt = await findUpcomingApptByPhone(empresaId, phone);
//         if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };

//         const duration = Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000));

//         const todayLocalISO = tzFormat(utcToZonedTime(params.ctx.now ?? new Date(), tz), "yyyy-MM-dd", { timeZone: tz });

//         const byDay = await getNextAvailableSlots(
//             { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
//             todayLocalISO, duration, daysHorizon, maxSlots
//         );

//         const flat = byDay.flatMap((d) => d.slots).slice(0, maxSlots);
//         if (!flat.length) return { handled: true, reply: "No veo cupos cercanos para reagendar. ¿Quieres que te contacte un asesor?", patch: basePatch };

//         const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
//         const bullets = labeled.map((l) => `• ${l.label}`).join("\n");

//         return {
//             handled: true,
//             reply: `Puedo mover tu cita. Horarios cercanos:\n${bullets}\n\nElige uno y escribe la hora (ej.: *2:30 pm* o *14:30*).`,
//             patch: {
//                 lastIntent: "reschedule",
//                 draft: { stage: "offer", name: appt.customerName ?? undefined, phone, procedureName: appt.serviceName, durationMin: duration, rescheduleApptId: appt.id },
//                 slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
//                 ...basePatch,
//             },
//         };
//     }

//     // si no es agenda (ni captura/confirmación), no lo manejo
//     const isCapture = Boolean(capturedName || capturedPhone) || HHMM_RE.test(text) || AMPM_RE.test(text);
//     const isConfirmWord = /^(1\b|confirmo\b|confirmar\b|si\b|sí\b|ok\b|dale\b|listo\b)/i.test(text.trim());
//     const wantsChange = /^(2\b|cambiar|otra|modificar|reprogramar)/i.test(text.trim());
//     const wantsAbort = /^(3\b|cancelar|anular)/i.test(text.trim());

//     if (!(intent === "schedule" || inDraft || isCapture || isConfirmWord || wantsChange || wantsAbort)) {
//         return { handled: false, patch: basePatch };
//     }

//     // servicio + duración
//     const svc = serviceInContext || ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) || null;
//     const duration = (svc?.durationMin ??
//         ctx.kb.defaultServiceDurationMin ??
//         60) as number;

//     // === Ofrecer slots (con filtro por franja si el usuario lo pidió)
//     if (intent === "schedule" && svc) {
//         const todayISO = tzFormat(utcToZonedTime(params.ctx.now ?? new Date(), tz), "yyyy-MM-dd", { timeZone: tz });

//         const byDay = await getNextAvailableSlots(
//             { empresaId, timezone: tz, vertical: ctx.kb.vertical, bufferMin: ctx.kb.bufferMin, granularityMin },
//             todayISO, duration, daysHorizon, maxSlots
//         );

//         let flat = byDay.flatMap((d) => d.slots);
//         const period = parseDayPeriod(text);
//         if (period) {
//             flat = flat.filter((s) => inPeriod(utcToZonedTime(new Date(s.startISO), tz), period));
//         }
//         flat = flat.slice(0, maxSlots);

//         if (!flat.length) {
//             return {
//                 handled: true,
//                 reply: "No veo cupos cercanos por ahora en esa franja. ¿Quieres que te muestre otros horarios u otra fecha?",
//                 patch: { lastIntent: "schedule", ...basePatch },
//             };
//         }

//         const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
//         const bullets = labeled.map((l) => `• ${l.label}`).join("\n");

//         const reply =
//             `Disponibilidad cercana para *${svc.name}*:\n${bullets}\n\n` +
//             `Elige una y dime tu *nombre* y *teléfono* para reservar.\n` +
//             `Si prefieres otra fecha u otra franja (mañana/tarde/noche), dímelo.`;

//         return {
//             handled: true,
//             reply, // ← SIN precios aquí (endurecido)
//             patch: {
//                 lastIntent: "schedule",
//                 lastServiceId: svc.id,
//                 lastServiceName: svc.name,
//                 draft: { ...(state.draft ?? {}), procedureId: svc.id, procedureName: svc.name, durationMin: duration, stage: "offer" },
//                 slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
//                 ...basePatch,
//             },
//         };
//     }

//     // === Captura → confirmación (sirve también si el usuario pide una franja estando en offer)
//     if (state.draft?.stage === "offer" && (isCapture || svc || parseDayPeriod(text))) {
//         const currentCache = state.slotsCache;

//         // Intento de match con hora local (admite 2:30 pm o 14:30)
//         let chosen = currentCache?.items?.[0];
//         const wantedMin = extractLocalMinutesFromText(text);
//         const periodAsked = parseDayPeriod(text);
//         if (wantedMin != null && currentCache?.items?.length) {
//             const hit = findSlotByLocalMinutes(currentCache.items, tz, wantedMin);
//             if (hit) chosen = hit;
//         } else if (periodAsked && currentCache?.items?.length) {
//             const hit = currentCache.items.find((s) => inPeriod(utcToZonedTime(new Date(s.startISO), tz), periodAsked));
//             if (hit) chosen = hit;
//         }

//         const nextDraft: SchedulingDraft = {
//             ...(state.draft ?? {}),
//             name: state.draft?.name ?? capturedName ?? undefined,
//             phone: state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
//             whenISO: state.draft?.whenISO ?? chosen?.startISO ?? undefined,
//             stage: "confirm",
//             procedureName: state.draft?.procedureName ?? (svc ? svc.name : undefined),
//             procedureId: state.draft?.procedureId ?? (svc ? svc.id : undefined),
//             durationMin: state.draft?.durationMin ?? duration,
//             rescheduleApptId: state.draft?.rescheduleApptId,
//         };

//         const local = nextDraft.whenISO ? utcToZonedTime(new Date(nextDraft.whenISO), tz) : null;
//         const fecha = local
//             ? local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit", timeZone: tz })
//             : "fecha por confirmar";
//         const hora = local ? formatAmPm(local) : "hora por confirmar";

//         const resumen =
//             `¿Confirmas la ${nextDraft.rescheduleApptId ? "reprogramación" : "reserva"}?\n` +
//             `• Procedimiento: ${nextDraft.procedureName ?? "—"}\n` +
//             `• Fecha/Hora: ${fecha} ${local ? `a las ${hora}` : ""}\n` +
//             `• Nombre: ${nextDraft.name ?? "—"}\n` +
//             `• Teléfono: ${nextDraft.phone ?? "—"}\n\n` +
//             `Responde *1 Confirmar* (o escribe *"confirmo"*), *2 Cambiar hora* o *3 Cancelar*.`;

//         return { handled: true, reply: resumen, patch: { draft: nextDraft, ...basePatch } };
//     }

//     // === Confirmación / cambiar / cancelar desde pantalla de confirmación
//     if (state.draft?.stage === "confirm") {
//         // 2) cambiar
//         if (wantsChange) {
//             // Reutilizamos o regeneramos slots
//             const todayISO = tzFormat(utcToZonedTime(params.ctx.now ?? new Date(), tz), "yyyy-MM-dd", { timeZone: tz });
//             const byDay = await getNextAvailableSlots(
//                 { empresaId, timezone: tz, vertical: ctx.kb.vertical, bufferMin: ctx.kb.bufferMin, granularityMin },
//                 todayISO,
//                 state.draft.durationMin ?? 60,
//                 daysHorizon,
//                 maxSlots
//             );
//             const flat = byDay.flatMap((d) => d.slots).slice(0, maxSlots);
//             if (!flat.length) {
//                 return {
//                     handled: true,
//                     reply: "No veo cupos cercanos. ¿Quieres que te contacte un asesor?",
//                     patch: { ...basePatch, draft: { ...(state.draft ?? {}), stage: "offer" } },
//                 };
//             }
//             const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
//             const bullets = labeled.map((l) => `• ${l.label}`).join("\n");
//             return {
//                 handled: true,
//                 reply: `Horarios disponibles cercanos:\n${bullets}\n\nElige uno y escribe la hora (ej.: *2:30 pm* o *14:30*).`,
//                 patch: {
//                     ...basePatch,
//                     draft: { ...(state.draft ?? {}), stage: "offer" },
//                     slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
//                 },
//             };
//         }

//         // 3) cancelar
//         if (wantsAbort) {
//             return {
//                 handled: true,
//                 reply: "Listo, no confirmo la reserva. Si quieres, te muestro otros horarios.",
//                 patch: { ...basePatch, draft: { stage: "idle" } },
//             };
//         }

//         // 1) confirmar (acepta confirmo/confirmar/sí/ok/listo/1)
//         if (isConfirmWord && state.draft.whenISO) {
//             try {
//                 const endISO = addMinutes(new Date(state.draft.whenISO), state.draft.durationMin ?? 60).toISOString();

//                 // Reagendar
//                 if (state.draft.rescheduleApptId) {
//                     await prisma.appointment.update({
//                         where: { id: state.draft.rescheduleApptId },
//                         data: { startAt: new Date(state.draft.whenISO), endAt: new Date(endISO), status: "confirmed" },
//                     });
//                     return {
//                         handled: true,
//                         createOk: true,
//                         reply: "¡Hecho! Tu cita fue reprogramada ✅. Te enviaremos recordatorio antes de la fecha.",
//                         patch: { draft: { stage: "idle" } },
//                     };
//                 }

//                 // Crear nueva
//                 const serviceName =
//                     state.draft.procedureName ||
//                     (ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0))?.name ?? "Procedimiento");

//                 await createAppointmentSafe({
//                     empresaId,
//                     vertical: ctx.kb.vertical,
//                     timezone: ctx.kb.timezone,
//                     procedureId: state.draft.procedureId ?? null,
//                     serviceName,
//                     customerName: state.draft.name || "Cliente",
//                     customerPhone: state.draft.phone || "",
//                     startISO: state.draft.whenISO,
//                     endISO,
//                     notes: "Agendado por IA",
//                     source: "ai",
//                 });

//                 return {
//                     handled: true,
//                     createOk: true,
//                     reply: "¡Hecho! Tu cita quedó confirmada ✅. Te enviaremos recordatorio antes de la fecha.",
//                     patch: { draft: { stage: "idle" } },
//                 };
//             } catch (_e) {
//                 return { handled: true, createOk: false, reply: "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?" };
//             }
//         }
//     }

//     // Nada más que hacer
//     return { handled: false, patch: basePatch };
// }














// utils/ai/strategies/esteticaModules/schedule/estetica.schedule.ts
import prisma from "../../../../../lib/prisma";
import {
    addDays,
    addMinutes,
    endOfDay,
    max as dfMax,
    startOfDay,
    nextWednesday,
    nextThursday,
    nextFriday,
    nextSaturday,
    nextSunday,
    nextMonday,
    nextTuesday,
    isAfter,
    startOfWeek,
} from "date-fns";
import {
    format as tzFormat,
    utcToZonedTime,
    zonedTimeToUtc,
} from "date-fns-tz";
import type {
    AppointmentSource,
    AppointmentStatus,
    AppointmentVertical,
    Weekday,
} from "@prisma/client";

/* ============================================================
   Tipos públicos (consumidos por estetica.strategy)
============================================================ */
export type Slot = { startISO: string; endISO: string };
export type SlotsByDay = { dateISO: string; slots: Slot[] };

export type KBMinimal = {
    vertical: AppointmentVertical | "custom";
    timezone: string;
    bufferMin?: number | null;
    defaultServiceDurationMin?: number | null;
    procedures: Array<{
        id: number;
        name: string;
        durationMin?: number | null;
    }>;
};

export type DraftStage = "idle" | "offer" | "confirm";
export type SchedulingDraft = {
    name?: string;
    phone?: string;
    procedureId?: number;
    procedureName?: string;
    whenISO?: string; // UTC ISO del inicio
    durationMin?: number;
    stage?: DraftStage;
    // reagendamiento
    rescheduleApptId?: number;
};

export type StateShape = {
    draft?: SchedulingDraft;
    lastIntent?: "info" | "price" | "schedule" | "reschedule" | "cancel" | "other";
    lastServiceId?: number | null;
    lastServiceName?: string | null;
    slotsCache?: {
        items: Array<{ startISO: string; endISO: string; label: string }>;
        expiresAt: string;
    };
    lastPhoneSeen?: string | null;
    scheduling_summary?: SchedulingSummary;
};

export type SchedulingCtx = {
    empresaId: number;
    kb: KBMinimal;
    granularityMin: number;
    daysHorizon: number;
    maxSlots: number;
    now?: Date;
    toCOP?: (v?: number | null) => string | null;
};

export type SchedulingResult = {
    handled: boolean;
    reply?: string;
    patch?: Partial<StateShape>;
    createOk?: boolean;
    needsHuman?: boolean;
    failMessage?: string;
};

/* ============================================================
   Summary operativo (vive en conversation_state.data)
============================================================ */
export type DayPeriod = "morning" | "afternoon" | "evening";
export type SchedulingSummary = {
    intent_resolved?: {
        text?: string;
        dayName?: string; // mon..sun
        explicitLocalDateISO?: string; // YYYY-MM-DD en TZ negocio
        period?: DayPeriod | null;
        tz: string;
    };
    candidate_slot?: { startISO: string; endISO: string; label: string } | null;
    last_offered_slots?: Array<{ startISO: string; endISO: string; label: string }>;
    missing?: Array<"procedure" | "name" | "phone" | "when">;
    price_info?: { procedureId: number; priceMin?: number | null } | null;
    staff_hint?: { name: string; role: string } | null;
};

/* ============================================================
   Utils de TZ y tiempo
============================================================ */
const WEEKDAY_ORDER: Record<Weekday, number> = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};
const WD_FROM_ES: Record<string, Weekday> = {
    domingo: "sun", lunes: "mon", martes: "tue", miercoles: "wed", miércoles: "wed",
    jueves: "thu", viernes: "fri", sabado: "sat", sábado: "sat",
};

function getWeekdayFromDate(dLocal: Date): Weekday {
    const dow = dLocal.getDay(); // 0..6
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] as Weekday);
}

function hhmmToUtc(dayLocalISO: string, hhmm: string, tz: string): Date {
    const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
    const localBase = utcToZonedTime(zonedTimeToUtc(dayLocalISO, tz), tz);
    localBase.setHours(h, m, 0, 0);
    return zonedTimeToUtc(localBase, tz);
}

function roundUpToGranularity(date: Date, granMin: number): Date {
    const step = granMin * 60_000;
    return new Date(Math.ceil(date.getTime() / step) * step);
}

const iso = (d: Date) => new Date(d.getTime()).toISOString();
const intervalsOverlap = (aS: Date, aE: Date, bS: Date, bE: Date) => aS < bE && bS < aE;

function formatAmPmLocal(d: Date) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12; h = h ? h : 12;
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm} ${ampm}`;
}

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}

/* ============================================================
   Construcción de ventanas (AppointmentHour + Exception)
============================================================ */
async function getOpenWindowsForDate(params: { empresaId: number; dateLocal: Date; tz: string; }) {
    const { empresaId, dateLocal, tz } = params;
    const weekday = getWeekdayFromDate(dateLocal);

    const base = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekday } },
    });

    // excepción del día (rango local 00:00–23:59)
    const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", { timeZone: tz });
    const startLocal = utcToZonedTime(zonedTimeToUtc(dayISO, tz), tz);
    const endLocal = utcToZonedTime(zonedTimeToUtc(
        tzFormat(dateLocal, "yyyy-MM-dd'T'23:59:59", { timeZone: tz }), tz
    ), tz);

    const exception = await prisma.appointmentException.findFirst({
        where: { empresaId, date: { gte: zonedTimeToUtc(startLocal, tz), lte: zonedTimeToUtc(endLocal, tz) } },
    });

    const open =
        exception?.isOpen === false
            ? []
            : ([
                { start: exception?.start1 ?? base?.start1 ?? null, end: exception?.end1 ?? base?.end1 ?? null },
                { start: exception?.start2 ?? base?.start2 ?? null, end: exception?.end2 ?? base?.end2 ?? null },
            ].filter((w) => w.start && w.end) as Array<{ start: string; end: string }>);

    return open.map(({ start, end }) => {
        const s = hhmmToUtc(dayISO, start, tz);
        const e = hhmmToUtc(dayISO, end, tz);
        return { startUtc: s, endUtc: e };
    });
}

/* ============================================================
   Ocupados del día
============================================================ */
async function getBusyIntervalsUTC(params: { empresaId: number; dayStartUtc: Date; dayEndUtc: Date; }) {
    const { empresaId, dayStartUtc, dayEndUtc } = params;
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    const appts = await prisma.appointment.findMany({
        where: {
            empresaId, deletedAt: null, status: { in: blocking },
            OR: [{ startAt: { lt: dayEndUtc }, endAt: { gt: dayStartUtc } }],
        },
        select: { startAt: true, endAt: true },
    });
    return appts.map((a) => ({ startUtc: a.startAt, endUtc: a.endAt }));
}

/* ============================================================
   Generación de slots
============================================================ */
function carveSlotsFromWindows(params: {
    windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
    busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
    durationMin: number;
    granMin: number;
    earliestAllowedUtc: Date;
    maxPerDay: number;
    filter?: { fromLocalMin?: number; toLocalMin?: number; tz?: string };
}): Slot[] {
    const { windowsUtc, busyUtc, durationMin, granMin, earliestAllowedUtc, maxPerDay, filter } = params;

    const withinPeriod = (d: Date) => {
        if (!filter?.fromLocalMin && !filter?.toLocalMin) return true;
        if (!filter?.tz) return true;
        const local = utcToZonedTime(d, filter.tz);
        const mm = local.getHours() * 60 + local.getMinutes();
        if (filter.fromLocalMin != null && mm < filter.fromLocalMin) return false;
        if (filter.toLocalMin != null && mm >= filter.toLocalMin) return false;
        return true;
    };

    const slots: Slot[] = [];
    for (const w of windowsUtc) {
        let cursor = roundUpToGranularity(dfMax([w.startUtc, earliestAllowedUtc]), granMin);
        while (true) {
            const end = addMinutes(cursor, durationMin);
            if (end > w.endUtc) break;
            if (!withinPeriod(cursor)) { cursor = addMinutes(cursor, granMin); if (cursor >= w.endUtc) break; continue; }
            const overlaps = busyUtc.some((b) => intervalsOverlap(cursor, end, b.startUtc, b.endUtc));
            if (!overlaps) {
                slots.push({ startISO: iso(cursor), endISO: iso(end) });
                if (slots.length >= maxPerDay) break;
            }
            cursor = addMinutes(cursor, granMin);
            if (cursor >= w.endUtc) break;
        }
        if (slots.length >= maxPerDay) break;
    }
    return slots;
}

/* ============================================================
   Lenguaje natural → Fecha/franja en TZ negocio
============================================================ */
export function parseDayPeriod(text: string): DayPeriod | null {
    const t = text.toLowerCase();
    if (/\b(mañana|manana|temprano|a primera hora)\b/.test(t)) return "morning";
    if (/\b(tarde|afternoon)\b/.test(t)) return "afternoon";
    if (/\b(noche|evening|tarde\s*noche)\b/.test(t)) return "evening";
    return null;
}

/** “próxima semana el jueves”, “esta semana el viernes” */
function resolveWeekRef(nowLocal: Date, tz: string, which: "esta" | "proxima"): Date {
    const monday0 = startOfWeek(nowLocal, { weekStartsOn: 1 });
    if (which === "esta") return monday0;
    // próxima semana = lunes de la siguiente semana
    return addDays(monday0, 7);
}

/** Devuelve la fecha local de un weekday dentro de la “base de semana” dada. */
function weekdayInBaseWeek(baseMondayLocal: Date, wd: Weekday): Date {
    const order: Record<Weekday, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: -1 }; // domingo antes del lunes
    const offset = order[wd] >= 0 ? order[wd] : 6; // si es domingo, lo llevamos al domingo de esa semana (baseMonday-1 ya pasó; traemos al domingo siguiente)
    return addDays(baseMondayLocal, offset);
}

/**
 * Convierte frases como:
 *  - “miércoles en la tarde”, “este miércoles”, “mañana”
 *  - “próxima semana el jueves”
 *  - “jueves 17 (en la tarde)”
 *  - “15/10”, “15 de octubre”
 */
export function interpretNaturalWhen(
    text: string,
    tz: string,
    now = new Date()
):
    | { localDateISO: string; period: DayPeriod | null; note: string }
    | null {
    const t = text.trim().toLowerCase();
    const nowLocal = utcToZonedTime(now, tz);

    // mañana / pasado mañana / hoy
    if (/\bpasado\s*mañana\b|\bpasado\s*manana\b/.test(t)) {
        const d = addDays(nowLocal, 2);
        return { localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "pasado_mañana" };
    }
    if (/\bmañana\b|\bmanana\b/.test(t)) {
        const d = addDays(nowLocal, 1);
        return { localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "mañana" };
    }
    if (/\bhoy\b/.test(t)) {
        const d = nowLocal;
        return { localDateISO: tzFormat(d, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "hoy" };
    }

    // próxima/esta semana + día
    const weekRef = /\b(pr[óo]xima|esta)\s+semana\b/.exec(t);
    const dayWord = Object.keys(WD_FROM_ES).find((w) => new RegExp(`\\b${w}\\b`, "i").test(t));
    if (weekRef && dayWord) {
        const wd = WD_FROM_ES[dayWord];
        const baseMonday = resolveWeekRef(nowLocal, tz, weekRef[1].startsWith("pr") ? "proxima" : "esta");
        const targetLocal = weekdayInBaseWeek(baseMonday, wd);
        return { localDateISO: tzFormat(targetLocal, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "semana+dia" };
    }

    // “jueves 17” (día de semana + número)
    const wdNum = /(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)\s+(\d{1,2})/.exec(t);
    if (wdNum) {
        const nDay = parseInt(wdNum[1], 10);
        const wdWord = (t.match(/lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo/i) || [])[0] || "";
        const wd = WD_FROM_ES[wdWord.normalize("NFD").replace(/\p{Diacritic}/gu, "")];
        const base = utcToZonedTime(now, tz);
        const month = base.getMonth();
        const year = base.getFullYear();
        const candidate = new Date(year, month, nDay, 0, 0, 0, 0);
        const localCand = utcToZonedTime(zonedTimeToUtc(candidate, tz), tz);
        // si ya pasó, empuja al mes siguiente
        const finalLocal = isAfter(localCand, base) ? localCand : new Date(year, month + 1, nDay);
        // validación suave: si el weekday no coincide, igual usamos la fecha (el usuario priorizó el número)
        return { localDateISO: tzFormat(finalLocal, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "wd+numero" };
    }

    // Sólo día de semana (“miércoles”, “jueves por la tarde”)
    if (dayWord) {
        const wd = WD_FROM_ES[dayWord];
        const todayWd = getWeekdayFromDate(nowLocal);
        const base = startOfDay(nowLocal);
        const map: Record<Weekday, (d: Date) => Date> = { sun: nextSunday, mon: nextMonday, tue: nextTuesday, wed: nextWednesday, thu: nextThursday, fri: nextFriday, sat: nextSaturday };
        const nextD = map[wd](base);
        const target = (wd === todayWd) ? nowLocal : nextD;
        return { localDateISO: tzFormat(target, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "dia_semana" };
    }

    // Fechas explícitas: 15/10, 15-10, 15 de octubre
    const dm = /(\b\d{1,2})\s*(\/|\-|de\s+)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|\d{1,2})/i.exec(t);
    if (dm) {
        const day = parseInt(dm[1], 10);
        const monthToken = dm[3].toLowerCase();
        const monthMap: Record<string, number> = {
            enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
        };
        const base = utcToZonedTime(now, tz);
        const year = base.getFullYear();
        const month = /\d{1,2}/.test(monthToken) ? Math.max(0, Math.min(11, parseInt(monthToken, 10) - 1)) : monthMap[monthToken];
        const candidate = new Date(year, month, day, 0, 0, 0, 0);
        const localCand = utcToZonedTime(zonedTimeToUtc(candidate, tz), tz);
        const finalLocal = isAfter(localCand, base) ? localCand : new Date(year + 1, month, day);
        return { localDateISO: tzFormat(finalLocal, "yyyy-MM-dd", { timeZone: tz }), period: parseDayPeriod(t), note: "fecha_dm" };
    }

    return null;
}

/* ============================================================
   API pública: slots disponibles (con filtro por franja)
============================================================ */
export async function getNextAvailableSlots(
    env: { empresaId: number; timezone: string; vertical: AppointmentVertical | "custom"; bufferMin?: number | null; granularityMin: number; },
    fromLocalDayISO: string,
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number,
    period?: DayPeriod | null
): Promise<SlotsByDay[]> {
    const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

    const baseLocalDate = utcToZonedTime(zonedTimeToUtc(`${fromLocalDayISO}T00:00:00`, tz), tz);
    const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

    const range = period ? (period === "morning" ? { from: 6 * 60, to: 12 * 60 } : period === "afternoon" ? { from: 12 * 60, to: 18 * 60 } : { from: 18 * 60, to: 21 * 60 }) : null;

    const results: SlotsByDay[] = [];
    for (let i = 0; i < daysHorizon; i++) {
        const dayLocal = addDays(baseLocalDate, i);
        const dayStartUtc = zonedTimeToUtc(startOfDay(dayLocal), tz);
        const dayEndUtc = zonedTimeToUtc(endOfDay(dayLocal), tz);

        const windowsUtc = await getOpenWindowsForDate({ empresaId, dateLocal: dayLocal, tz });
        if (!windowsUtc.length) {
            results.push({ dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }), slots: [] });
            continue;
        }

        const busyUtc = await getBusyIntervalsUTC({ empresaId, dayStartUtc, dayEndUtc });
        const slots = carveSlotsFromWindows({
            windowsUtc, busyUtc, durationMin, granMin: granularityMin, earliestAllowedUtc, maxPerDay,
            filter: range ? { fromLocalMin: range.from, toLocalMin: range.to, tz } : undefined,
        });

        results.push({ dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }), slots });
    }
    return results;
}

/* ============================================================
   Crear cita segura
============================================================ */
export async function createAppointmentSafe(args: {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string;
    endISO: string;
    notes?: string;
    source?: "ai" | "web" | "manual" | "client";
}) {
    const { empresaId, procedureId, serviceName, customerName, customerPhone, startISO, endISO, notes, source, timezone } = args;

    const startAt = new Date(startISO);
    const endAt = new Date(endISO);

    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    const overlap = await prisma.appointment.findFirst({
        where: { empresaId, deletedAt: null, status: { in: blocking }, OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }] },
        select: { id: true },
    });
    if (overlap) throw new Error("OVERLAP");

    const SOURCE_MAP: Record<string, AppointmentSource> = { ai: "client" as AppointmentSource, web: "web" as AppointmentSource, manual: "manual" as AppointmentSource, client: "client" as AppointmentSource };
    const safeSource: AppointmentSource = SOURCE_MAP[source || "client"];

    const created = await prisma.appointment.create({
        data: {
            empresaId,
            procedureId: procedureId ?? null,
            serviceName,
            customerName,
            customerPhone,
            startAt,
            endAt,
            status: "confirmed",
            source: safeSource,
            notas: notes ?? null,
            timezone: timezone || "America/Bogota",
            customerDisplayName: customerName,
            serviceDurationMin: Math.max(1, Math.round((endAt.getTime() - startAt.getTime()) / 60000)),
            locationNameCache: null,
        },
    });
    return { ok: true, id: created.id };
}

/* ============================================================
   Helpers UX (labels, parsing hora, confirmaciones)
============================================================ */
function labelSlotsForTZ(slots: Slot[], tz: string) {
    return slots.map((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const dia = d.toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "short", timeZone: tz });
        const label = `${dia}, ${formatAmPmLocal(d)}`;
        return { startISO: s.startISO, endISO: s.endISO, label };
    });
}

const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/;
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

function properCase(v?: string) {
    return (v || "").trim().replace(/\s+/g, " ")
        // @ts-ignore Unicode escapes
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
function normalizePhone(raw?: string): string | undefined {
    if (!raw) return undefined;
    const digits = raw.replace(/\D+/g, ""); if (!digits) return undefined;
    return digits.length >= 10 ? digits.slice(-10) : digits;
}
function extractLocalMinutesFromText(text: string): number | null {
    const m12 = AMPM_RE.exec(text);
    if (m12) { let h = parseInt(m12[1], 10); const minutes = m12[2] ? parseInt(m12[2], 10) : 0; const ampm = m12[3].toLowerCase(); if (h === 12) h = 0; if (ampm === "pm") h += 12; return h * 60 + minutes; }
    const m24 = HHMM_RE.exec(text);
    if (m24) { const h = parseInt(m24[1], 10); const minutes = parseInt(m24[2], 10); return h * 60 + minutes; }
    return null;
}
function inPeriodLocal(d: Date, period: DayPeriod): boolean {
    const h = d.getHours();
    if (period === "morning") return h >= 6 && h < 12;
    if (period === "afternoon") return h >= 12 && h < 18;
    return h >= 18 && h <= 21;
}
function findSlotByLocalMinutes<T extends { startISO: string; endISO: string }>(items: T[], tz: string, targetMin: number): T | undefined {
    return items.find((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const mm = d.getHours() * 60 + d.getMinutes();
        return mm === targetMin;
    });
}
async function findUpcomingApptByPhone(empresaId: number, phone: string) {
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    return prisma.appointment.findFirst({
        where: { empresaId, customerPhone: { contains: phone }, status: { in: blocking }, startAt: { gte: new Date() } },
        orderBy: { startAt: "asc" },
    });
}
const CONFIRM_OK_RE = /\b(confirmo|s[íi]|si|dale|ok|listo|perfecto|queda\s+as[íi])\b/i;

/* ============================================================
   Orquestador de turno (schedule + cancel + reschedule)
============================================================ */
export async function handleSchedulingTurn(params: {
    text: string;
    state: StateShape;
    ctx: SchedulingCtx;
    serviceInContext?: { id: number; name: string; durationMin?: number | null } | null;
    intent: "price" | "schedule" | "reschedule" | "cancel" | "info" | "other";
}): Promise<SchedulingResult> {
    const { text, state, ctx, serviceInContext, intent } = params;
    const { kb, empresaId, granularityMin, daysHorizon, maxSlots } = ctx;
    const tz = kb.timezone;

    // intención explícita de cancelar / reagendar
    const wantsCancel = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i.test(text);
    const wantsReschedule = /\b(reagendar|reprogramar|cambiar\s+hora|otro\s+horario|mover\s+cita)\b/i.test(text);

    // capturas libres
    const nameMatch = NAME_RE.exec(text);
    const phoneMatch = PHONE_ANY_RE.exec(text);
    const capturedName = nameMatch ? properCase(nameMatch[2]) : undefined;
    const capturedPhone = normalizePhone(phoneMatch?.[2]);
    const wantedMin = extractLocalMinutesFromText(text);
    const periodAsked = parseDayPeriod(text);
    const basePatch: Partial<StateShape> = {};
    if (capturedPhone) basePatch.lastPhoneSeen = capturedPhone;

    // === Cancelar
    if (intent === "cancel" || wantsCancel) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };
        const appt = await findUpcomingApptByPhone(empresaId, phone);
        if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };
        await prisma.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
        return { handled: true, reply: "Listo, tu cita fue *cancelada*. Si deseas, te muestro nuevos horarios.", patch: { draft: { stage: "idle" }, lastIntent: "cancel", ...basePatch } };
    }

    // === Reagendar
    if (intent === "reschedule" || wantsReschedule) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };
        const appt = await findUpcomingApptByPhone(empresaId, phone);
        if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };

        const duration = Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000));
        const interp = interpretNaturalWhen(text, tz, ctx.now ?? new Date());
        const pivotLocalISO = interp?.localDateISO ?? tzFormat(utcToZonedTime(ctx.now ?? new Date(), tz), "yyyy-MM-dd", { timeZone: tz });

        const byDay = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
            pivotLocalISO, duration, daysHorizon, maxSlots, interp?.period ?? null
        );

        const flat = byDay.flatMap((d) => d.slots).slice(0, maxSlots);
        if (!flat.length) return { handled: true, reply: "No veo cupos cercanos para reagendar. ¿Quieres que te contacte un asesor?", patch: basePatch };

        const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");

        return {
            handled: true,
            reply: `Puedo mover tu cita. Horarios cercanos:\n${bullets}\n\nElige uno y escríbeme la hora (ej.: *2:30 pm* o *14:30*).`,
            patch: {
                lastIntent: "reschedule",
                draft: { stage: "offer", name: appt.customerName ?? undefined, phone, procedureName: appt.serviceName, durationMin: duration, rescheduleApptId: appt.id },
                slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
                scheduling_summary: {
                    intent_resolved: { text, tz, period: interp?.period ?? null, explicitLocalDateISO: interp?.localDateISO },
                    last_offered_slots: labeled,
                    missing: [],
                },
                ...basePatch,
            },
        };
    }

    // servicio + duración
    const svc = serviceInContext || ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) || null;
    const duration = (svc?.durationMin ?? ctx.kb.defaultServiceDurationMin ?? 60) as number;

    // === Confirmación explícita (crea cita)
    if (state.draft?.stage === "confirm" && state.draft.whenISO && CONFIRM_OK_RE.test(text)) {
        try {
            const endISO = addMinutes(new Date(state.draft.whenISO), state.draft.durationMin ?? 60).toISOString();
            await createAppointmentSafe({
                empresaId, vertical: ctx.kb.vertical, timezone: tz,
                procedureId: state.draft.procedureId ?? null,
                serviceName: state.draft.procedureName || (svc ? svc.name : "Procedimiento"),
                customerName: state.draft.name || "Cliente",
                customerPhone: state.draft.phone || "",
                startISO: state.draft.whenISO, endISO,
                notes: "Agendado por IA", source: "ai",
            });
            return { handled: true, createOk: true, reply: "¡Listo! Tu cita quedó confirmada ✅.", patch: { draft: { stage: "idle" } } };
        } catch {
            return { handled: true, createOk: false, reply: "Ese horario acaba de ocuparse 😕. ¿Te comparto otras opciones cercanas?" };
        }
    }

    // === Ofrecer slots (no bot: no pasamos a confirm si faltan datos)
    if (intent === "schedule" && (svc || serviceInContext)) {
        const interp = interpretNaturalWhen(text, tz, ctx.now ?? new Date());

        // Si todavía no entendemos la fecha, pedimos el día de forma natural.
        if (!interp) {
            const nombres = ctx.kb.procedures.slice(0, 3).map(p => p.name).join(", ");
            return {
                handled: true,
                reply: `Para mostrarte horarios, dime el *día* (p. ej., *jueves*, *mañana* o *15/10*). Si prefieres otro procedimiento, dime cuál (ej.: ${nombres}).`,
                patch: { lastIntent: "schedule", ...basePatch }
            };
        }

        const pivotLocalISO = interp.localDateISO;
        const byDay = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: ctx.kb.vertical, bufferMin: ctx.kb.bufferMin, granularityMin },
            pivotLocalISO, duration, daysHorizon, maxSlots, interp.period ?? null
        );

        let flat = byDay.flatMap((d) => d.slots);
        const period = interp.period ?? periodAsked;
        if (period) flat = flat.filter((s) => inPeriodLocal(utcToZonedTime(new Date(s.startISO), tz), period));
        flat = flat.slice(0, maxSlots);

        if (!flat.length) {
            return {
                handled: true,
                reply: "No veo cupos en esa franja. ¿Quieres que te muestre en otra (mañana/tarde/noche) o en otro día?",
                patch: {
                    lastIntent: "schedule",
                    scheduling_summary: {
                        intent_resolved: { text, tz, period: period ?? null, explicitLocalDateISO: interp.localDateISO },
                        last_offered_slots: [],
                        missing: ["when"],
                    },
                    ...basePatch,
                },
            };
        }

        const labeled = labelSlotsForTZ(flat, tz).slice(0, Math.min(3, flat.length));
        const bullets = labeled.map((l) => `• ${l.label}`).join("\n");
        const ask =
            `Disponibilidad para *${(svc || serviceInContext)!.name}* el día indicado:\n${bullets}\n\n` +
            `Elige una hora y dime tu *nombre* y *teléfono* para reservar.`;

        // No pasamos a confirm: dejamos stage=offer y pedimos faltantes
        const missing: SchedulingSummary["missing"] = [];
        if (!state.draft?.name) missing.push("name");
        if (!state.draft?.phone) missing.push("phone");

        return {
            handled: true,
            reply: ask,
            patch: {
                lastIntent: "schedule",
                lastServiceId: (svc || serviceInContext)!.id,
                lastServiceName: (svc || serviceInContext)!.name,
                draft: { ...(state.draft ?? {}), procedureId: (svc || serviceInContext)!.id, procedureName: (svc || serviceInContext)!.name, durationMin: duration, stage: "offer" },
                slotsCache: { items: labeled, expiresAt: nowPlusMin(10) },
                scheduling_summary: {
                    intent_resolved: { text, tz, period: period ?? null, explicitLocalDateISO: interp.localDateISO },
                    last_offered_slots: labeled,
                    missing,
                },
                ...basePatch,
            },
        };
    }

    // === Captura progresiva: elegida hora / nombre / teléfono → si ya hay todo, pedir confirmación humana
    if ((state.draft?.stage === "offer" || intent === "schedule") && (svc || state.draft?.procedureId)) {
        const currentCache = state.slotsCache;

        let chosen = currentCache?.items?.[0];
        if (wantedMin != null && currentCache?.items?.length) {
            const hit = findSlotByLocalMinutes(currentCache.items, tz, wantedMin);
            if (hit) chosen = hit;
        } else if (periodAsked && currentCache?.items?.length) {
            const hit = currentCache.items.find((s) => inPeriodLocal(utcToZonedTime(new Date(s.startISO), tz), periodAsked));
            if (hit) chosen = hit;
        }

        const nextDraft: SchedulingDraft = {
            ...(state.draft ?? {}),
            name: state.draft?.name ?? capturedName ?? undefined,
            phone: state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
            whenISO: state.draft?.whenISO ?? chosen?.startISO ?? undefined,
            stage: "offer", // seguimos en offer hasta confirmar
            procedureName: state.draft?.procedureName ?? (svc ? svc.name : undefined),
            procedureId: state.draft?.procedureId ?? (svc ? svc.id : undefined),
            durationMin: state.draft?.durationMin ?? duration,
            rescheduleApptId: state.draft?.rescheduleApptId,
        };

        const missing: SchedulingSummary["missing"] = [];
        if (!nextDraft.whenISO) missing.push("when");
        if (!nextDraft.name) missing.push("name");
        if (!nextDraft.phone) missing.push("phone");

        // Si ya tenemos todo → pedimos confirmación humana (sin crear todavía)
        if (missing.length === 0) {
            const local = utcToZonedTime(new Date(nextDraft.whenISO!), tz);
            const fecha = local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit", timeZone: tz });
            const hora = formatAmPmLocal(local);
            const resumen = `Quedaría así:\n• Procedimiento: ${nextDraft.procedureName}\n• Fecha/Hora: ${fecha}, ${hora}\n• Nombre: ${nextDraft.name}\n• Teléfono: ${nextDraft.phone}\n\n¿*Lo confirmo*?`;
            return {
                handled: true,
                reply: resumen,
                patch: { draft: { ...nextDraft, stage: "confirm" }, scheduling_summary: { ...state.scheduling_summary, candidate_slot: { startISO: nextDraft.whenISO!, endISO: addMinutes(new Date(nextDraft.whenISO!), nextDraft.durationMin ?? 60).toISOString(), label: `${fecha}, ${hora}` }, missing: [] } },
            };
        }

        // Aún faltan datos → pedir exactamente lo que falta (natural)
        const asks: string[] = [];
        if (missing.includes("when")) asks.push("el *horario* (puedes responder 2:30 pm o elegir uno de los que te pasé)");
        if (missing.includes("name")) asks.push("tu *nombre*");
        if (missing.includes("phone")) asks.push("tu *teléfono* (solo números)");
        const ask = `Perfecto, avanzo con ${nextDraft.procedureName}. Para reservar necesito ${asks.join(" y ")}.`;

        return { handled: true, reply: ask, patch: { draft: nextDraft, scheduling_summary: { ...state.scheduling_summary, missing } } };
    }

    // Nada que hacer aquí
    return { handled: false, patch: basePatch };
}

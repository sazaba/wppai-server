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








/*
 * Estética – Scheduling Engine (rápido y eficiente)
 * - Sin migraciones de schema: usa Prisma + memoria para holds/idempotencia.
 * - Totalmente tipado en TS.
 * - Exporta: getNextAvailableSlots, createAppointmentSafe, handleSchedulingTurn.
 */

import prisma from "../../../../../lib/prisma";
import { addMinutes, differenceInMinutes, isAfter, isBefore } from "date-fns";
import { utcToZonedTime, zonedTimeToUtc, format as tzFormat } from "date-fns-tz";
import type { AppointmentVertical, AppointmentStatus, AppointmentSource } from "@prisma/client";

/* ==========================
   Tipos públicos
   ========================== */
export type Slot = { startISO: string; endISO: string };
export type DaySlots = { dateISO: string; slots: Slot[] };

export type AvailabilityCtx = {
    empresaId: number;
    timezone: string;
    vertical: AppointmentVertical | "custom" | null;
    bufferMin?: number | null;
    granularityMin: number; // paso de slots
};

export type CreateApptArgs = {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string;
    endISO: string;
    notes?: string | null;
    source?: AppointmentSource;
    requestId?: string | null; // idempotencia en memoria (rápida)
};

export type SchedulingTurnArgs = {
    text: string;
    state: {
        draft?: any;
        lastIntent?: string | null;
        lastServiceId?: number | null;
        lastServiceName?: string | null;
        slotsCache?: { items: Array<{ startISO: string; endISO: string; label: string }>; expiresAt: string } | null;
        lastPhoneSeen?: string | null;
    };
    ctx: {
        empresaId: number;
        kb: {
            vertical: AppointmentVertical | "custom" | null;
            timezone: string;
            bufferMin: number | null;
            defaultServiceDurationMin: number | null;
            procedures: Array<{ id: number; name: string; durationMin: number | null }>;
        };
        granularityMin: number;
        daysHorizon: number;
        maxSlots: number;
        toCOP?: (v?: number | null) => string | null;
    };
    serviceInContext: { id: number; name: string; durationMin: number | null } | null;
    intent: "schedule" | "reschedule" | "cancel" | "price" | "info" | "other";
};

export type SchedulingTurnResult = {
    handled: boolean;
    reply?: string;
    createOk?: boolean;
    patch?: Partial<SchedulingTurnArgs["state"]>;
};

/* ==========================
   Utilidades de TZ y días
   ========================== */
const WEEKDAYS: Array<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"> = [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
];

function dayKeyInTZ(d: Date, tz: string): (typeof WEEKDAYS)[number] {
    const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz })
        .format(d)
        .toLowerCase()
        .slice(0, 3) as (typeof WEEKDAYS)[number];
    return wd;
}

function minutesInTZ(d: Date, tz: string): number {
    const [hh, mm] = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
    })
        .format(d)
        .split(":")
        .map(Number);
    return hh * 60 + mm;
}

function sameCalendarDayInTZ(a: Date, b: Date, tz: string): boolean {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(a) === fmt.format(b);
}

function dayBoundsUTC(d: Date, tz: string) {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const [y, m, day] = ymd.split("-").map(Number);
    const start = new Date(Date.UTC(y, (m as number) - 1, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, (m as number) - 1, day, 23, 59, 59, 999));
    return { start, end };
}

const toMinutes = (hhmm?: string | null) => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
};

function isInsideRanges(
    startMin: number,
    endMin: number,
    r1: { s: number | null; e: number | null },
    r2: { s: number | null; e: number | null }
): boolean {
    const inR1 = r1.s != null && r1.e != null && startMin >= r1.s && endMin <= r1.e;
    const inR2 = r2.s != null && r2.e != null && startMin >= r2.s && endMin <= r2.e;
    return inR1 || inR2;
}

/* ==========================
   Config runtime (Appt > Legacy)
   ========================== */
async function loadApptRuntimeConfig(empresaId: number) {
    const [cfgAppt, cfgLegacy] = await Promise.all([
        prisma.businessConfigAppt.findUnique({ where: { empresaId } }),
        prisma.businessConfig.findUnique({
            where: { empresaId },
            select: {
                appointmentEnabled: true,
                appointmentTimezone: true,
                appointmentBufferMin: true,
                appointmentPolicies: true,
                appointmentReminders: true,
            },
        }),
    ]);

    return {
        appointmentEnabled: (cfgAppt?.appointmentEnabled ?? cfgLegacy?.appointmentEnabled) ?? false,
        timezone: (cfgAppt?.appointmentTimezone ?? cfgLegacy?.appointmentTimezone) || "America/Bogota",
        bufferMin: (cfgAppt?.appointmentBufferMin ?? cfgLegacy?.appointmentBufferMin) ?? 10,

        minNoticeH: cfgAppt?.appointmentMinNoticeHours ?? null,
        maxAdvanceD: cfgAppt?.appointmentMaxAdvanceDays ?? null,
        allowSameDay: cfgAppt?.allowSameDayBooking ?? false,

        bookingWindowDays: cfgAppt?.bookingWindowDays ?? null,
        maxDailyAppointments: cfgAppt?.maxDailyAppointments ?? null,

        locationName: cfgAppt?.locationName ?? null,
        defaultServiceDurationMin: cfgAppt?.defaultServiceDurationMin ?? null,
    } as const;
}

function violatesNoticeAndWindow(
    cfg: { minNoticeH: number | null; maxAdvanceD: number | null; allowSameDay: boolean; bookingWindowDays: number | null },
    startAt: Date
) {
    const now = new Date();
    const sameDay = startAt.toDateString() === now.toDateString();
    if (!cfg.allowSameDay && sameDay) return true;

    const hoursDiff = (startAt.getTime() - now.getTime()) / 3_600_000;
    if (cfg.minNoticeH != null && hoursDiff < cfg.minNoticeH) return true;

    const maxD = cfg.maxAdvanceD != null ? cfg.maxAdvanceD : cfg.bookingWindowDays != null ? cfg.bookingWindowDays : null;
    if (maxD != null) {
        const maxMs = maxD * 24 * 3_600_000;
        if (startAt.getTime() - now.getTime() > maxMs) return true;
    }
    return false;
}

async function isExceptionDay(empresaId: number, d: Date) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const ex = await prisma.appointmentException.findFirst({ where: { empresaId, date: day }, select: { id: true, isOpen: true, start1: true, end1: true, start2: true, end2: true } });
    return ex || null;
}

async function hasOverlapWithBuffer(opts: { empresaId: number; startAt: Date; endAt: Date; bufferMin: number; ignoreId?: number }) {
    const { empresaId, startAt, endAt, bufferMin, ignoreId } = opts;
    const startBuf = addMinutes(startAt, -bufferMin);
    const endBuf = addMinutes(endAt, bufferMin);

    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            ...(ignoreId ? { id: { not: ignoreId } } : {}),
            status: { in: ["pending", "confirmed", "rescheduled"] },
            OR: [{ startAt: { lt: endBuf }, endAt: { gt: startBuf } }],
        },
        select: { id: true },
    });
    return !!overlap;
}

async function ensureDailyCap(opts: { empresaId: number; when: Date; timezone: string; cap: number | null | undefined; ignoreId?: number }) {
    const { empresaId, when, timezone, cap, ignoreId } = opts;
    if (!cap || cap <= 0) return { ok: true } as const;

    const { start, end } = dayBoundsUTC(when, timezone);
    const count = await prisma.appointment.count({
        where: {
            empresaId,
            startAt: { gte: start },
            endAt: { lte: end },
            status: { in: ["pending", "confirmed", "rescheduled"] },
            ...(ignoreId ? { id: { not: ignoreId } } : {}),
        },
    });

    if (count >= cap) return { ok: false as const, code: 409 as const, msg: "Límite diario de citas alcanzado." };
    return { ok: true as const };
}

/* ==========================
   Hold / Idempotencia (memoria)
   ========================== */
const holds = new Map<string, number>(); // key -> expiresAt(ms)
const IDEMP = new Map<string, { apptId: number; at: number }>(); // empresaId|requestId -> appt
const HOLD_TTL_MS = 150 * 1000; // 150s
const IDEMP_TTL_MS = 5 * 60 * 1000; // 5min

function makeSlotKey(empresaId: number, startISO: string, endISO: string) {
    return `${empresaId}|${startISO}|${endISO}`;
}

function cleanupMaps() {
    const now = Date.now();
    for (const [k, exp] of holds.entries()) if (now > exp) holds.delete(k);
    for (const [k, v] of IDEMP.entries()) if (now - v.at > IDEMP_TTL_MS) IDEMP.delete(k);
}

export function holdSlot(empresaId: number, startISO: string, endISO: string) {
    cleanupMaps();
    const k = makeSlotKey(empresaId, startISO, endISO);
    const exp = Date.now() + HOLD_TTL_MS;
    holds.set(k, exp);
    return { ok: true as const, expiresAt: new Date(exp).toISOString() };
}

function isSlotHeld(empresaId: number, startISO: string, endISO: string) {
    cleanupMaps();
    const k = makeSlotKey(empresaId, startISO, endISO);
    const exp = holds.get(k);
    return !!exp && Date.now() <= exp;
}

/* ==========================
   Núcleo: disponibilidad
   ========================== */
export async function getNextAvailableSlots(
    ctx: AvailabilityCtx,
    startDateISO: string,
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number
): Promise<DaySlots[]> {
    const empresaId = ctx.empresaId;
    const tz = ctx.timezone;
    const { granularityMin } = ctx;
    const bufMin = (ctx.bufferMin ?? 10);

    // Carga config para minNotice/bookingWindow
    const cfg = await loadApptRuntimeConfig(empresaId);

    const startLocal = utcToZonedTime(new Date(startDateISO), tz);
    const results: DaySlots[] = [];

    for (let i = 0; i < daysHorizon; i++) {
        const dayLocal = addMinutes(startLocal, i * 1440);
        const dayKey = dayKeyInTZ(dayLocal, tz) as "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

        // Horario por día
        const hours = await prisma.appointmentHour.findUnique({ where: { empresaId_day: { empresaId, day: dayKey as any } } });
        // Excepción del día
        const ex = await isExceptionDay(empresaId, dayLocal);

        // Cerrar día si no hay hours y no hay excepción abierta
        if (!hours && !ex) continue;

        const isOpen = ex?.isOpen === false ? false : (hours?.isOpen ?? true);
        if (!isOpen) continue;

        const ranges: Array<{ s: number | null; e: number | null }> = [];
        const r1 = {
            s: toMinutes((ex?.start1 as string | null) ?? hours?.start1 ?? null),
            e: toMinutes((ex?.end1 as string | null) ?? hours?.end1 ?? null),
        };
        const r2 = {
            s: toMinutes((ex?.start2 as string | null) ?? hours?.start2 ?? null),
            e: toMinutes((ex?.end2 as string | null) ?? hours?.end2 ?? null),
        };
        if (r1.s != null && r1.e != null && r1.s < r1.e) ranges.push(r1);
        if (r2.s != null && r2.e != null && r2.s < r2.e) ranges.push(r2);
        if (!ranges.length) continue;

        const { start, end } = dayBoundsUTC(dayLocal, tz);

        // Appointments del día con buffer
        const appts = await prisma.appointment.findMany({
            where: {
                empresaId,
                status: { in: ["pending", "confirmed", "rescheduled"] },
                startAt: { lt: end },
                endAt: { gt: start },
            },
            select: { id: true, startAt: true, endAt: true },
        });

        const blocked: Array<{ s: Date; e: Date }> = appts.map((a) => ({ s: addMinutes(a.startAt, -bufMin), e: addMinutes(a.endAt, bufMin) }));

        const daySlots: Slot[] = [];

        // Generar slots por cada rango
        for (const rng of ranges) {
            const startMin = rng.s as number;
            const endMin = rng.e as number;

            for (let m = startMin; m + durationMin <= endMin; m += granularityMin) {
                const localStart = new Date(
                    Date.UTC(
                        dayLocal.getUTCFullYear(),
                        dayLocal.getUTCMonth(),
                        dayLocal.getUTCDate(),
                        0,
                        0,
                        0,
                        0
                    )
                );
                // Movernos m minutos en TZ → a UTC
                const tLocal = utcToZonedTime(localStart, tz);
                tLocal.setHours(0, 0, 0, 0);
                const slotLocalStart = addMinutes(tLocal, m);
                const slotLocalEnd = addMinutes(slotLocalStart, durationMin);

                const slotUTCStart = zonedTimeToUtc(slotLocalStart, tz);
                const slotUTCEnd = zonedTimeToUtc(slotLocalEnd, tz);

                // Reglas de ventana
                if (violatesNoticeAndWindow(cfg, slotUTCStart)) continue;

                // Overlap con citas (con buffer) + holds activos
                const overlap = blocked.some((b) => slotUTCStart < b.e && slotUTCEnd > b.s);
                if (overlap) continue;
                if (isSlotHeld(empresaId, slotUTCStart.toISOString(), slotUTCEnd.toISOString())) continue;

                daySlots.push({ startISO: slotUTCStart.toISOString(), endISO: slotUTCEnd.toISOString() });
                if (daySlots.length >= maxPerDay) break;
            }
            if (daySlots.length >= maxPerDay) break;
        }

        if (daySlots.length) {
            const dateISO = tzFormat(utcToZonedTime(dayLocal, tz), "yyyy-MM-dd", { timeZone: tz });
            results.push({ dateISO, slots: daySlots });
        }
    }

    return results;
}

/* ==========================
   Crear cita (seguro)
   ========================== */
export async function createAppointmentSafe(args: CreateApptArgs) {
    const {
        empresaId,
        timezone,
        procedureId,
        serviceName,
        customerName,
        customerPhone,
        startISO,
        endISO,
        notes,
        source = "ai",
        requestId,
    } = args;

    const cfg = await loadApptRuntimeConfig(empresaId);
    if (!cfg.appointmentEnabled) throw Object.assign(new Error("La agenda está deshabilitada para esta empresa."), { status: 403 });

    const start = new Date(startISO);
    const end = new Date(endISO);
    if (!(start < end)) throw Object.assign(new Error("startAt debe ser menor que endAt"), { status: 400 });

    // Horario + excepción
    const dayKey = dayKeyInTZ(utcToZonedTime(start, timezone), timezone);
    const hours = await prisma.appointmentHour.findUnique({ where: { empresaId_day: { empresaId, day: dayKey as any } } });
    const ex = await isExceptionDay(empresaId, utcToZonedTime(start, timezone));

    if (ex && ex.isOpen === false) throw Object.assign(new Error("Día bloqueado por excepción."), { status: 409 });

    if (hours) {
        const sMin = minutesInTZ(utcToZonedTime(start, timezone), timezone);
        const eMin = minutesInTZ(utcToZonedTime(end, timezone), timezone);
        const r1 = { s: toMinutes((ex?.start1 as string | null) ?? hours.start1 ?? null), e: toMinutes((ex?.end1 as string | null) ?? hours.end1 ?? null) };
        const r2 = { s: toMinutes((ex?.start2 as string | null) ?? hours.start2 ?? null), e: toMinutes((ex?.end2 as string | null) ?? hours.end2 ?? null) };
        if (!isInsideRanges(sMin, eMin, r1, r2)) throw Object.assign(new Error("Horario fuera de disponibilidad."), { status: 409 });
    }

    // Ventanas
    if (violatesNoticeAndWindow(cfg, start)) throw Object.assign(new Error("El horario solicitado no cumple con las reglas de reserva."), { status: 409 });

    // Cap diario
    const cap = await ensureDailyCap({ empresaId, when: start, timezone, cap: cfg.maxDailyAppointments });
    if (!cap.ok) throw Object.assign(new Error(cap.msg), { status: cap.code });

    // Overlap + buffer
    const overlap = await hasOverlapWithBuffer({ empresaId, startAt: start, endAt: end, bufferMin: cfg.bufferMin });
    if (overlap) throw Object.assign(new Error("Existe otra cita en ese intervalo (buffer aplicado)."), { status: 409 });

    // Hold en memoria (best-effort)
    holdSlot(empresaId, start.toISOString(), end.toISOString());

    // Idempotencia en memoria
    if (requestId) {
        const key = `${empresaId}|${requestId}`;
        const prev = IDEMP.get(key);
        if (prev) {
            const appt = await prisma.appointment.findUnique({ where: { id: prev.apptId } });
            if (appt) return appt;
            IDEMP.delete(key);
        }
    }

    const appt = await prisma.appointment.create({
        data: {
            empresaId,
            source: source as AppointmentSource,
            status: "confirmed" as AppointmentStatus,
            customerName,
            customerPhone,
            serviceName,
            notas: notes ?? null,
            startAt: start,
            endAt: end,
            timezone: timezone || cfg.timezone || "America/Bogota",
            procedureId: procedureId ?? null,
            customerDisplayName: customerName ?? null,
            serviceDurationMin: differenceInMinutes(end, start),
            locationNameCache: cfg.locationName ?? null,
        },
    });

    if (requestId) IDEMP.set(`${empresaId}|${requestId}`, { apptId: appt.id, at: Date.now() });

    return appt;
}

/* ==========================
   handleSchedulingTurn – MVP (deja pasar a la strategy si no aplica)
   ========================== */
export async function handleSchedulingTurn(args: SchedulingTurnArgs): Promise<SchedulingTurnResult> {
    const t = (args.text || "").toLowerCase();

    // Cancelación simple por ID (si el usuario envía algo como: "cancelar 123")
    const cancelMatch = /(cancelar|anular)\s*(cita)?\s*(#|id)?\s*(\d{1,10})/.exec(t);
    if (cancelMatch) {
        const id = Number(cancelMatch[4]);
        if (Number.isFinite(id)) {
            const appt = await prisma.appointment.findUnique({ where: { id } });
            if (!appt) return { handled: true, reply: "No encuentro esa cita." };
            if (appt.status === "cancelled") return { handled: true, reply: "Esa cita ya estaba cancelada." };
            await prisma.appointment.update({ where: { id }, data: { status: "cancelled" } });
            return { handled: true, reply: "Listo, tu cita ha sido cancelada ✅" };
        }
    }

    // Reagendar sencillo (placeholder): detecta intención pero deja que la strategy siga
    if (/(reagendar|reprogramar|cambiar\s+cita)/.test(t)) {
        return { handled: false, patch: { lastIntent: "reschedule" } };
    }

    // Pedir horarios (placeholder): dejamos que la strategy muestre slots
    if (/(horarios|disponibilidad|ver\s+horas|ver\s+horarios)/.test(t)) {
        return { handled: false, patch: { lastIntent: "schedule" } };
    }

    return { handled: false };
}

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
    differenceInMinutes,
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
    whenISO?: string;
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

    /** Firma simple para evitar respuestas duplicadas en el mismo turno */
    lastMsgKey?: string | null;
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
   Utils de TZ y tiempo
============================================================ */
const DOW_MAP: Record<string, Weekday> = {
    domingo: "sun",
    dom: "sun",
    lunes: "mon",
    lun: "mon",
    martes: "tue",
    mar: "tue",
    miercoles: "wed",
    miércoles: "wed",
    miercoles2: "wed",
    mie: "wed",
    mié: "wed",
    jueves: "thu",
    jue: "thu",
    viernes: "fri",
    vie: "fri",
    sabado: "sat",
    sábado: "sat",
    sab: "sat",
    sáb: "sat",
};

function getWeekdayFromDate(dLocal: Date): Weekday {
    const dow = dLocal.getDay(); // 0..6
    return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow] || "mon") as Weekday;
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

function formatAmPm(d: Date) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    h = h ? h : 12;
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm} ${ampm}`;
}

function nowPlusMin(min: number) {
    return new Date(Date.now() + min * 60_000).toISOString();
}

/* ============================================================
   Construcción de ventanas (AppointmentHour + Exception)
============================================================ */
async function getOpenWindowsForDate(params: {
    empresaId: number;
    dateLocal: Date;
    tz: string;
}) {
    const { empresaId, dateLocal, tz } = params;
    const weekday = getWeekdayFromDate(dateLocal);

    const base = await prisma.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: weekday } },
    });

    // excepción del día (rango local 00:00–23:59)
    const dayISO = tzFormat(dateLocal, "yyyy-MM-dd'T'00:00:00", { timeZone: tz });
    const startLocal = utcToZonedTime(zonedTimeToUtc(dayISO, tz), tz);
    const endLocal = utcToZonedTime(
        zonedTimeToUtc(tzFormat(dateLocal, "yyyy-MM-dd'T'23:59:59", { timeZone: tz }), tz),
        tz
    );

    const exception = await prisma.appointmentException.findFirst({
        where: {
            empresaId,
            date: {
                gte: zonedTimeToUtc(startLocal, tz),
                lte: zonedTimeToUtc(endLocal, tz),
            },
        },
    });

    const open =
        exception?.isOpen === false
            ? []
            : [
                { start: exception?.start1 ?? base?.start1 ?? null, end: exception?.end1 ?? base?.end1 ?? null },
                { start: exception?.start2 ?? base?.start2 ?? null, end: exception?.end2 ?? base?.end2 ?? null },
            ].filter((w) => w.start && w.end) as Array<{ start: string; end: string }>;

    return open.map(({ start, end }) => {
        const s = hhmmToUtc(dayISO, start, tz);
        const e = hhmmToUtc(dayISO, end, tz);
        return { startUtc: s, endUtc: e };
    });
}

/* ============================================================
   Ocupados del día (Appointment en estados que bloquean)
============================================================ */
async function getBusyIntervalsUTC(params: {
    empresaId: number;
    dayStartUtc: Date;
    dayEndUtc: Date;
}) {
    const { empresaId, dayStartUtc, dayEndUtc } = params;
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    const appts = await prisma.appointment.findMany({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: blocking },
            OR: [{ startAt: { lt: dayEndUtc }, endAt: { gt: dayStartUtc } }],
        },
        select: { startAt: true, endAt: true },
    });
    return appts.map((a) => ({ startUtc: a.startAt, endUtc: a.endAt }));
}

/* ============================================================
   Generación de slots (día puntual)
============================================================ */
function carveSlotsFromWindows(params: {
    windowsUtc: Array<{ startUtc: Date; endUtc: Date }>;
    busyUtc: Array<{ startUtc: Date; endUtc: Date }>;
    durationMin: number;
    granMin: number;
    earliestAllowedUtc: Date;
    maxPerDay: number;
}): Slot[] {
    const { windowsUtc, busyUtc, durationMin, granMin, earliestAllowedUtc, maxPerDay } = params;

    const slots: Slot[] = [];
    for (const w of windowsUtc) {
        let cursor = roundUpToGranularity(dfMax([w.startUtc, earliestAllowedUtc]), granMin);
        while (true) {
            const end = addMinutes(cursor, durationMin);
            if (end > w.endUtc) break;

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

async function getSlotsForLocalDate(
    empresaId: number,
    tz: string,
    localDate: Date,
    durationMin: number,
    granularityMin: number,
    bufferMin: number | null | undefined,
    maxPerDay: number
): Promise<Slot[]> {
    const dayStartUtc = zonedTimeToUtc(startOfDay(localDate), tz);
    const dayEndUtc = zonedTimeToUtc(endOfDay(localDate), tz);
    const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

    const windowsUtc = await getOpenWindowsForDate({ empresaId, dateLocal: localDate, tz });
    if (!windowsUtc.length) return [];

    const busyUtc = await getBusyIntervalsUTC({ empresaId, dayStartUtc, dayEndUtc });

    return carveSlotsFromWindows({
        windowsUtc,
        busyUtc,
        durationMin,
        granMin: granularityMin,
        earliestAllowedUtc,
        maxPerDay,
    });
}

/* ============================================================
   API pública original (se conserva para compatibilidad)
============================================================ */
export async function getNextAvailableSlots(
    env: {
        empresaId: number;
        timezone: string;
        vertical: AppointmentVertical | "custom";
        bufferMin?: number | null;
        granularityMin: number;
    },
    fromDateISO: string,
    durationMin: number,
    daysHorizon: number,
    maxPerDay: number
): Promise<SlotsByDay[]> {
    const { empresaId, timezone: tz, bufferMin, granularityMin } = env;

    const baseLocalDate = utcToZonedTime(new Date(fromDateISO + "T00:00:00Z"), tz);
    const earliestAllowedUtc = addMinutes(new Date(), Math.max(bufferMin ?? 0, 0));

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
            windowsUtc,
            busyUtc,
            durationMin,
            granMin: granularityMin,
            earliestAllowedUtc,
            maxPerDay,
        });

        results.push({ dateISO: tzFormat(dayLocal, "yyyy-MM-dd", { timeZone: tz }), slots });
    }

    return results;
}

/* ============================================================
   Crear cita segura (Prisma directo) – CONFIRMED
============================================================ */
export async function createAppointmentSafe(args: {
    empresaId: number;
    vertical: AppointmentVertical | "custom";
    timezone: string;
    procedureId?: number | null;
    serviceName: string;
    customerName: string;
    customerPhone: string;
    startISO: string; // UTC ISO
    endISO: string;   // UTC ISO
    notes?: string;
    source?: "ai" | "web" | "manual" | "client";
}) {
    const {
        empresaId,
        procedureId,
        serviceName,
        customerName,
        customerPhone,
        startISO,
        endISO,
        notes,
        source,
        timezone,
    } = args;

    const startAt = new Date(startISO);
    const endAt = new Date(endISO);

    // 1) overlap rápido
    const blocking: AppointmentStatus[] = ["pending", "confirmed", "rescheduled"];
    const overlap = await prisma.appointment.findFirst({
        where: {
            empresaId,
            deletedAt: null,
            status: { in: blocking },
            OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
        },
        select: { id: true },
    });
    if (overlap) throw new Error("OVERLAP");

    // 2) fuente segura (evita crash si enum no tiene "ai")
    const SOURCE_MAP: Record<string, AppointmentSource> = {
        ai: "client" as AppointmentSource,
        web: "web" as AppointmentSource,
        manual: "manual" as AppointmentSource,
        client: "client" as AppointmentSource,
    };
    const safeSource: AppointmentSource = SOURCE_MAP[source || "client"];

    // 3) create alineado al controller
    try {
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
                serviceDurationMin: Math.max(
                    1,
                    Math.round((endAt.getTime() - startAt.getTime()) / 60000)
                ),
                locationNameCache: null,
            },
        });
        return { ok: true, id: created.id };
    } catch (e) {
        console.error("[createAppointmentSafe] ❌", e);
        throw e;
    }
}

/* ============================================================
   Helpers de UX (labels y parsing)
============================================================ */
function labelSlotsForTZ(slots: Slot[], tz: string) {
    return slots.map((s) => {
        const d = utcToZonedTime(new Date(s.startISO), tz);
        const dia = d.toLocaleDateString("es-CO", {
            weekday: "long",
            day: "2-digit",
            month: "short",
            timeZone: tz,
        });
        const label = `${dia}, ${formatAmPm(d)}`;
        return { startISO: s.startISO, endISO: s.endISO, label };
    });
}

// Capturas
const NAME_RE = /(mi\s+nombre\s+es|soy|me\s+llamo)\s+([a-záéíóúñ\s]{2,60})/i;
const PHONE_ANY_RE = /(\+?57)?\D*?(\d{7,12})\b/;   // 7–12 dígitos
const HHMM_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/; // 24h
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i; // 12h

function properCase(v?: string) {
    return (v || "")
        .trim()
        .replace(/\s+/g, " ")
        // @ts-ignore
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function normalizePhone(raw?: string): string | undefined {
    if (!raw) return undefined;
    const digits = raw.replace(/\D+/g, "");
    if (!digits) return undefined;
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Si no dice "me llamo/soy", intenta tomar el primer token alfabético como nombre. */
function fallbackNameFromText(text: string): string | undefined {
    const m = text.match(/([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})?/);
    return m ? properCase(m[0]) : undefined;
}

/** Extrae HH:MM local en minutos desde 00:00 (acepta 14:30 o 2:30 pm). */
function extractLocalMinutesFromText(text: string): number | null {
    const m12 = AMPM_RE.exec(text);
    if (m12) {
        let h = parseInt(m12[1], 10);
        const minutes = m12[2] ? parseInt(m12[2], 10) : 0;
        const ampm = m12[3].toLowerCase();
        if (h === 12) h = 0;
        if (ampm === "pm") h += 12;
        return h * 60 + minutes;
    }
    const m24 = HHMM_RE.exec(text);
    if (m24) {
        const h = parseInt(m24[1], 10);
        const minutes = parseInt(m24[2], 10);
        return h * 60 + minutes;
    }
    return null;
}

/** Franja del día pedida por texto. */
type DayPeriod = "morning" | "afternoon" | "evening";
function parseDayPeriod(text: string): DayPeriod | null {
    const t = text.toLowerCase();
    if (/\b(mañana|manana|temprano|a primera hora)\b/.test(t)) return "morning";
    if (/\b(tarde|after\s*noon)\b/.test(t)) return "afternoon";
    if (/\b(noche|tarde-noche|tarde noche|evening)\b/.test(t)) return "evening";
    return null;
}
function inPeriod(d: Date, period: DayPeriod): boolean {
    const h = d.getHours();
    if (period === "morning") return h >= 6 && h < 12;
    if (period === "afternoon") return h >= 12 && h < 18;
    return h >= 18 && h <= 21;
}

/** Día de semana o número de día solicitado en el texto (ej: "jueves 15") */
function parseRequestedDate(text: string, tz: string, now: Date): { targetLocalDate: Date | null; period?: DayPeriod; exactMinutes?: number } {
    const t = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const period = parseDayPeriod(text);
    const mNum = t.match(/\b(\d{1,2})\b/);
    const dayNumber = mNum ? parseInt(mNum[1], 10) : undefined;

    let weekday: Weekday | undefined;
    for (const key of Object.keys(DOW_MAP)) {
        const k = key.normalize("NFD").replace(/\p{Diacritic}/gu, "");
        if (new RegExp(`\\b${k}\\b`).test(t)) {
            weekday = DOW_MAP[key];
            break;
        }
    }

    // Base: hoy en zona
    const todayLocal = utcToZonedTime(now, tz);
    const baseYear = todayLocal.getFullYear();
    const baseMonth = todayLocal.getMonth();

    let candidate = new Date(todayLocal);
    candidate.setHours(0, 0, 0, 0);

    if (dayNumber !== undefined) {
        // preferimos el del mes actual si aún no pasó; sino, siguiente mes
        const inThisMonth = new Date(baseYear, baseMonth, dayNumber, 0, 0, 0, 0);
        const inNextMonth = new Date(baseYear, baseMonth + 1, Math.min(dayNumber, 28), 0, 0, 0, 0); // safe bound

        if (inThisMonth >= todayLocal) candidate = inThisMonth;
        else candidate = inNextMonth;
    }

    if (weekday) {
        // mover candidate al próximo weekday solicitado (si no se dio dayNumber, parte desde hoy)
        let tries = 0;
        while (getWeekdayFromDate(candidate) !== weekday && tries < 7) {
            candidate = addDays(candidate, 1);
            tries++;
        }
    }

    const exactMinutes = extractLocalMinutesFromText(text); // puede venir “3:00 pm”
    return {
        targetLocalDate: candidate || null,
        period: period ?? undefined,              // <- normaliza null -> undefined
        exactMinutes: exactMinutes ?? undefined,
    };

}

/** Busca el slot más cercano a una fecha/hora objetivo dentro del horizonte */
function findNearestSlot(slotsMatrix: SlotsByDay[], tz: string, wished: Date): Slot | null {
    const all = slotsMatrix.flatMap((d) => d.slots);
    if (!all.length) return null;
    let best: Slot | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const s of all) {
        const diff = Math.abs(differenceInMinutes(utcToZonedTime(new Date(s.startISO), tz), wished));
        if (diff < bestDiff) {
            bestDiff = diff;
            best = s;
        }
    }
    return best;
}

/* ============================================================
   Autoconfirmación
============================================================ */
function hasAllDataForBooking(d: SchedulingDraft): boolean {
    // Autoconfirmamos con teléfono + hora + servicio (nombre o id). El nombre del cliente es opcional.
    return Boolean(d.whenISO && d.phone && (d.procedureName || d.procedureId));
}

async function finalizeBookingAuto(
    draft: SchedulingDraft,
    ctx: SchedulingCtx
): Promise<{ ok: boolean; msg: string }> {
    const tz = ctx.kb.timezone;
    const duration = draft.durationMin ?? ctx.kb.defaultServiceDurationMin ?? 60;
    const endISO = addMinutes(new Date(draft.whenISO!), duration).toISOString();

    // Reagendar
    if (draft.rescheduleApptId) {
        await prisma.appointment.update({
            where: { id: draft.rescheduleApptId },
            data: { startAt: new Date(draft.whenISO!), endAt: new Date(endISO), status: "confirmed" },
        });
        const local = utcToZonedTime(new Date(draft.whenISO!), tz);
        const f = local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit", timeZone: tz });
        const h = formatAmPm(local);
        return {
            ok: true,
            msg: `¡Listo! Tu cita fue *reprogramada y confirmada* ✅\n• ${draft.procedureName ?? "Procedimiento"}\n• ${f} a las ${h}\nSi necesitas *cambiar* la hora o *cancelar*, me dices.`,
        };
    }

    // Crear nueva
    const serviceName =
        draft.procedureName ||
        (ctx.kb.procedures.find((p) => p.id === (draft.procedureId ?? 0))?.name ?? "Procedimiento");

    await createAppointmentSafe({
        empresaId: ctx.empresaId,
        vertical: ctx.kb.vertical,
        timezone: ctx.kb.timezone,
        procedureId: draft.procedureId ?? null,
        serviceName,
        customerName: draft.name || "Cliente",
        customerPhone: draft.phone || "",
        startISO: draft.whenISO!,
        endISO,
        notes: "Agendado automáticamente por IA",
        source: "ai",
    });

    const local = utcToZonedTime(new Date(draft.whenISO!), tz);
    const f = local.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "2-digit", timeZone: tz });
    const h = formatAmPm(local);

    return {
        ok: true,
        msg: `¡Hecho! Tu cita quedó *confirmada* ✅\n• ${serviceName}\n• ${f} a las ${h}\nSi deseas *cambiar* o *cancelar*, dime y lo ajusto.`,
    };
}

/* ============================================================
   Orquestador: ahora el cliente PROPONE fecha/hora
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

    // Señales base
    const wantsCancel = /\b(cancelar|anular|no puedo ir|cancela|cancelemos)\b/i.test(text);
    const wantsReschedule = /\b(reagendar|reprogramar|cambiar\s+hora|otro\s+horario|mover\s+cita)\b/i.test(text);

    // Capturas
    const nameMatch = NAME_RE.exec(text);
    const phoneMatch = PHONE_ANY_RE.exec(text);
    const capturedName = nameMatch ? properCase(nameMatch[2]) : fallbackNameFromText(text);
    const capturedPhone = normalizePhone(phoneMatch?.[2]);

    const basePatch: Partial<StateShape> = {};
    if (capturedPhone) basePatch.lastPhoneSeen = capturedPhone;

    // === Cancelar
    if (intent === "cancel" || wantsCancel) {
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };

        const appt = await prisma.appointment.findFirst({
            where: {
                empresaId,
                customerPhone: { contains: phone },
                status: { in: ["pending", "confirmed", "rescheduled"] },
                startAt: { gte: new Date() },
            },
            orderBy: { startAt: "asc" },
        });
        if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };

        await prisma.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
        return { handled: true, reply: "Listo, tu cita fue *cancelada*. Si deseas, te muestro otros horarios.", patch: { draft: { stage: "idle" }, lastIntent: "cancel", ...basePatch } };
    }

    // === Reagendar (el cliente seguirá proponiendo fecha/hora)
    if (intent === "reschedule" || wantsReschedule) {
        // caemos al mismo flujo de propuesta, pero guardando rescheduleApptId
        const phone = state.draft?.phone || capturedPhone || state.lastPhoneSeen;
        if (!phone) return { handled: true, reply: "Para ubicar tu cita necesito tu *teléfono*. Escríbelo (solo números).", patch: basePatch };

        const appt = await prisma.appointment.findFirst({
            where: {
                empresaId,
                customerPhone: { contains: phone },
                status: { in: ["pending", "confirmed", "rescheduled"] },
                startAt: { gte: new Date() },
            },
            orderBy: { startAt: "asc" },
        });
        if (!appt) return { handled: true, reply: "No encuentro una cita próxima con ese teléfono. ¿Podrías verificar el número?", patch: basePatch };

        // seteamos draft para que al confirmar fecha/hora se actualice esa cita
        return {
            handled: true,
            reply: "Claro, dime *qué fecha y hora* te gustaría para mover tu cita (ej.: *jueves 15 a las 4:00 pm*).",
            patch: {
                draft: {
                    stage: "offer",
                    name: appt.customerName ?? undefined,
                    phone,
                    procedureName: appt.serviceName,
                    durationMin: Math.max(15, Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000)),
                    rescheduleApptId: appt.id,
                },
                ...basePatch,
            },
        };
    }

    // Si no estamos en agenda, salir
    if (!(intent === "schedule" || state.draft?.stage === "offer" || state.draft?.stage === "confirm" || PHONE_ANY_RE.test(text))) {
        return { handled: false, patch: basePatch };
    }

    // Servicio + duración
    const svc = serviceInContext ||
        ctx.kb.procedures.find((p) => p.id === (state.draft?.procedureId ?? 0)) || null;
    const duration = (svc?.durationMin ?? kb.defaultServiceDurationMin ?? 60) as number;

    // === Cliente propone fecha/hora (núcleo del nuevo flujo)
    if (intent === "schedule" || state.draft?.stage === "offer" || PHONE_ANY_RE.test(text)) {
        // Parsear fecha/hora deseada
        const now = params.ctx.now ?? new Date();
        const parsed = parseRequestedDate(text, tz, now);

        // si no detectamos fecha, pedirla (no ofrecer lista)
        if (!parsed.targetLocalDate) {
            const ask = "¿Qué *fecha y hora* te gustaría? Ejemplos: *jueves 15 a las 3:00 pm* o *viernes en la tarde*.";
            return {
                handled: true,
                reply: ask,
                patch: {
                    lastIntent: "schedule",
                    draft: {
                        ...(state.draft ?? {}),
                        stage: "offer",
                        name: state.draft?.name ?? capturedName ?? undefined,
                        phone: state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
                        procedureName: state.draft?.procedureName ?? (svc ? svc.name : undefined),
                        procedureId: state.draft?.procedureId ?? (svc ? svc.id : undefined),
                        durationMin: state.draft?.durationMin ?? duration,
                    },
                    ...basePatch,
                },
            };
        }

        // Slots del día solicitado
        const daySlots = await getSlotsForLocalDate(
            empresaId,
            tz,
            parsed.targetLocalDate,
            duration,
            granularityMin,
            kb.bufferMin,
            Math.max(maxSlots, 8)
        );

        // Si el cliente dijo “en la tarde/mañana/noche”, filtramos
        const filtered = parsed.period
            ? daySlots.filter((s) => inPeriod(utcToZonedTime(new Date(s.startISO), tz), parsed.period!))
            : daySlots;

        // Si dio hora exacta, intentamos casar exactamente esa hora
        if (parsed.exactMinutes !== undefined) {
            const exact = filtered.find((s) => {
                const d = utcToZonedTime(new Date(s.startISO), tz);
                return d.getHours() * 60 + d.getMinutes() === parsed.exactMinutes;
            });

            if (exact) {
                // Tenemos match exacto → Guardar y autoconfirmar si hay teléfono
                const nextDraft: SchedulingDraft = {
                    ...(state.draft ?? {}),
                    name: state.draft?.name ?? capturedName ?? undefined,
                    phone: state.draft?.phone ?? (capturedPhone || state.lastPhoneSeen) ?? undefined,
                    whenISO: exact.startISO,
                    stage: "confirm",
                    procedureName: state.draft?.procedureName ?? (svc ? svc.name : undefined),
                    procedureId: state.draft?.procedureId ?? (svc ? svc.id : undefined),
                    durationMin: state.draft?.durationMin ?? duration,
                    rescheduleApptId: state.draft?.rescheduleApptId,
                };

                if (hasAllDataForBooking(nextDraft)) {
                    try {
                        const result = await finalizeBookingAuto(nextDraft, ctx);
                        return { handled: true, createOk: result.ok, reply: result.msg, patch: { draft: { stage: "idle" }, ...basePatch } };
                    } catch {
                        // Buscar alternativa más cercana
                        const startISO = tzFormat(parsed.targetLocalDate, "yyyy-MM-dd", { timeZone: tz });
                        const matrix = await getNextAvailableSlots(
                            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
                            startISO, duration, Math.max(3, daysHorizon), Math.max(maxSlots, 8)
                        );
                        const nearest = findNearestSlot(matrix, tz, parsed.targetLocalDate);
                        if (!nearest) return { handled: true, reply: "Ese horario se ocupó justo ahora. No veo cercanos disponibles.", patch: basePatch };
                        const d = utcToZonedTime(new Date(nearest.startISO), tz);
                        const alt = `${d.toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "short", timeZone: tz })} a las ${formatAmPm(d)}`;
                        return {
                            handled: true,
                            reply: `Esa hora no está disponible. La más cercana es *${alt}*. Si te sirve, dime tu *teléfono* y nombre para reservar.`,
                            patch: { ...basePatch, draft: { ...nextDraft, whenISO: nearest.startISO } },
                        };
                    }
                } else {
                    // Falta teléfono (o servicio) → pedir mínimo teléfono; nombre opcional
                    const dloc = utcToZonedTime(new Date(exact.startISO), tz);
                    const fecha = dloc.toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "short", timeZone: tz });
                    const hora = formatAmPm(dloc);
                    const missing: string[] = [];
                    if (!nextDraft.phone) missing.push("*teléfono*");
                    if (!nextDraft.procedureName && !nextDraft.procedureId) missing.push("*servicio*");

                    return {
                        handled: true,
                        reply: `Perfecto, *${fecha} a las ${hora}* está disponible. Para fijarla necesito ${missing.join(" y ")}. (El *nombre* es opcional).`,
                        patch: { ...basePatch, draft: nextDraft },
                    };
                }
            } else {
                // No hay ese exacto → buscar la más cercana (en día solicitado primero)
                const wishedLocal = new Date(parsed.targetLocalDate);
                const hh = Math.floor(parsed.exactMinutes / 60);
                const mm = parsed.exactMinutes % 60;
                wishedLocal.setHours(hh, mm, 0, 0);

                const labeled = labelSlotsForTZ(filtered, tz);
                if (labeled.length) {
                    // devolver 2–3 alternativas del mismo día
                    const bullets = labeled.slice(0, 3).map((l) => `• ${l.label}`).join("\n");
                    return {
                        handled: true,
                        reply: `No tengo exactamente esa hora, pero ese día están libres:\n${bullets}\nDime cuál prefieres y tu *teléfono* para reservar.`,
                        patch: { ...basePatch, slotsCache: { items: labeled, expiresAt: nowPlusMin(10) }, draft: { ...(state.draft ?? {}), stage: "offer", durationMin: duration, procedureId: svc?.id, procedureName: svc?.name } },
                    };
                }

                // Ningún slot ese día → buscar el más cercano en el horizonte
                const startISO = tzFormat(parsed.targetLocalDate, "yyyy-MM-dd", { timeZone: tz });
                const matrix = await getNextAvailableSlots(
                    { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
                    startISO, duration, Math.max(3, daysHorizon), Math.max(maxSlots, 8)
                );
                const nearest = findNearestSlot(matrix, tz, wishedLocal);
                if (!nearest) {
                    return { handled: true, reply: "No veo cupos cercanos a esa hora. ¿Quieres proponer otra hora o día?", patch: basePatch };
                }
                const d = utcToZonedTime(new Date(nearest.startISO), tz);
                const alt = `${d.toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "short", timeZone: tz })} a las ${formatAmPm(d)}`;
                return {
                    handled: true,
                    reply: `Esa hora no está disponible. La más cercana es *${alt}*. Si te sirve, dime tu *teléfono* para reservar.`,
                    patch: { ...basePatch, draft: { ...(state.draft ?? {}), stage: "offer", whenISO: nearest.startISO, durationMin: duration, procedureId: svc?.id, procedureName: svc?.name } },
                };
            }
        }

        // No hubo hora exacta, solo día/franja → listar slots de ese día (no más de 3)
        const dayList = labelSlotsForTZ(filtered, tz);
        if (dayList.length) {
            const bullets = dayList.slice(0, 3).map((l) => `• ${l.label}`).join("\n");
            return {
                handled: true,
                reply: `Ese día puedo agendar en:\n${bullets}\nResponde con la *hora* elegida (ej.: 3:00 pm) y tu *teléfono* para reservar.`,
                patch: { ...basePatch, slotsCache: { items: dayList, expiresAt: nowPlusMin(10) }, draft: { ...(state.draft ?? {}), stage: "offer", durationMin: duration, procedureId: svc?.id, procedureName: svc?.name } },
            };
        }

        // Ese día no hay → buscar el más cercano
        const startISO = tzFormat(parsed.targetLocalDate, "yyyy-MM-dd", { timeZone: tz });
        const matrix = await getNextAvailableSlots(
            { empresaId, timezone: tz, vertical: kb.vertical, bufferMin: kb.bufferMin, granularityMin },
            startISO, duration, Math.max(3, daysHorizon), Math.max(maxSlots, 8)
        );
        const wishedLocal = parsed.targetLocalDate;
        const nearest = findNearestSlot(matrix, tz, wishedLocal);
        if (!nearest) {
            return { handled: true, reply: "No veo cupos cercanos a esa fecha. ¿Quieres proponer otra fecha u horario?", patch: basePatch };
        }
        const d = utcToZonedTime(new Date(nearest.startISO), tz);
        const alt = `${d.toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "short", timeZone: tz })} a las ${formatAmPm(d)}`;
        return {
            handled: true,
            reply: `Ese día no tengo disponibilidad. La opción más cercana es *${alt}*. Si te sirve, dime tu *teléfono* para reservar.`,
            patch: { ...basePatch, draft: { ...(state.draft ?? {}), stage: "offer", whenISO: nearest.startISO, durationMin: duration, procedureId: svc?.id, procedureName: svc?.name } },
        };
    }

    // === Confirmación/edición por compatibilidad (si el usuario termina escribiendo "confirmo")
    if (state.draft?.stage === "confirm" && state.draft.whenISO) {
        try {
            const res = await finalizeBookingAuto(state.draft, ctx);
            return { handled: true, createOk: res.ok, reply: res.msg, patch: { draft: { stage: "idle" } } };
        } catch {
            return { handled: true, createOk: false, reply: "Ese horario acaba de ocuparse. ¿Quieres que te muestre otra opción cercana?" };
        }
    }

    return { handled: false, patch: basePatch };
}


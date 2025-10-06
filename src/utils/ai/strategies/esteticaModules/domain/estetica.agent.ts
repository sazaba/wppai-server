// utils/ai/strategies/esteticaModules/domain/estetica.agent.ts
// Full-agent (agenda natural + tools + KB) con staff-awareness, manejo de exceptions
// y fallback proactivo cuando el modelo no ejecuta tools.

import prisma from "../../../../../lib/prisma";
import { openai, resolveModelName } from "../../../../../lib/openai";
import { AppointmentStatus, AppointmentSource } from "@prisma/client";
import type { EsteticaCtx } from "./estetica.rag";

/* ======================= LLM CFG ======================= */
const RAW_MODEL = process.env.ESTETICA_MODEL || "gpt-4o-mini";
const MODEL = resolveModelName(RAW_MODEL);
const TEMPERATURE = Number(process.env.IA_TEMPERATURE ?? 0.35);
const DEBUG = String(process.env.ESTETICA_DEBUG ?? "0") !== "0";

/* ======================= Tipos chat ======================= */
export type ChatTurn = { role: "user" | "assistant"; content: string };
type AssistantMsg = {
    role: "assistant";
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
};
type ToolMsg = { role: "tool"; tool_call_id: string; content: string };

/* ======================= Utils ======================= */
function safeParseArgs(raw?: string) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}
const ENDINGS = ["¿Te parece?", "¿Confirmamos?", "¿Te va bien?"];

// Cierre amable y 1 emoji
function postProcessReply(reply: string, history: ChatTurn[]): string {
    const clean = reply.trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (!clean) return clean;
    const add = ENDINGS[history.length % ENDINGS.length];
    const withEnding = /[.?!…]$/.test(clean) ? `${clean} ${add}` : `${clean}. ${add}`;
    const hasEmoji = /\p{Extended_Pictographic}/u.test(withEnding);
    return hasEmoji ? withEnding : `${withEnding} 🙂`;
}

/* ======================= Fecha/TZ helpers ======================= */
function addMinutes(d: Date, m: number) { return new Date(d.getTime() + m * 60000); }
function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86400000); }
function ymdInTZ(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function makeZonedDate(ymd: string, hhmm: string, tz: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, h, mi));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess);
    const gotH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const gotM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const delta = h * 60 + mi - (gotH * 60 + gotM);
    return new Date(guess.getTime() + delta * 60000);
}
function startOfDayTZ(d: Date, tz: string) { return makeZonedDate(ymdInTZ(d, tz), "00:00", tz); }
// function endOfDayTZ(d: Date, tz: string) { return makeZonedDate(ymdInTZ(d, tz), "23:59", tz); }

// Buscar “mañana 06:00” local por defecto
function nextLocalMorning(ctx: EsteticaCtx, daysAhead = 1): Date {
    const tz = ctx.timezone;
    const base = addDays(new Date(), daysAhead);
    return makeZonedDate(ymdInTZ(base, tz), "06:00", tz);
}

/* ====== Corrección opcional de timezone en appointmentHours ====== */
// Si tus hours están guardadas en UTC y el negocio opera en America/Bogota (-300 min),
// define: APPT_HOURS_TZ_OFFSET_MIN=-300
const HOURS_TZ_OFFSET_MIN = Number(process.env.APPT_HOURS_TZ_OFFSET_MIN ?? 0);
function hhmmWithOffset(hhmm: string): string {
    if (!HOURS_TZ_OFFSET_MIN) return hhmm;
    const [h, m] = hhmm.split(":").map(Number);
    let total = h * 60 + m + HOURS_TZ_OFFSET_MIN;
    total = ((total % 1440) + 1440) % 1440;
    const H = Math.floor(total / 60).toString().padStart(2, "0");
    const M = (total % 60).toString().padStart(2, "0");
    return `${H}:${M}`;
}

/* ======================= Disponibilidad base ======================= */
type HourRow = {
    day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
    isOpen?: boolean | null;
    start1: string | null; end1: string | null;
    start2: string | null; end2: string | null;
};
type ExceptionRow = {
    date: Date;
    isOpen: boolean | null;
    start1: string | null; end1: string | null;
    start2: string | null; end2: string | null;
};
type StaffRow = {
    id: number;
    enabled?: boolean | null; // compat
    active?: boolean | null;  // compat
};

async function fetchHours(empresaId: number): Promise<HourRow[]> {
    const rows = await prisma.appointmentHour.findMany({
        where: { empresaId },
        select: { day: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    return rows as unknown as HourRow[];
}
async function fetchExceptions(empresaId: number): Promise<ExceptionRow[]> {
    const rows = await prisma.appointmentException.findMany({
        where: { empresaId },
        select: { date: true, isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    return rows.map(r => ({
        date: r.date, isOpen: r.isOpen ?? null,
        start1: r.start1 ?? null, end1: r.end1 ?? null, start2: r.start2 ?? null, end2: r.end2 ?? null,
    }));
}
async function fetchStaffSafe(empresaId: number): Promise<StaffRow[]> {
    try {
        const rows = await prisma.staff.findMany({
            where: { empresaId, OR: [{ enabled: true }, { enabled: null }, { active: true }, { active: null }] },
            select: { id: true, enabled: true, active: true },
            orderBy: { id: "asc" },
        } as any);
        return rows as unknown as StaffRow[];
    } catch {
        return []; // modo compatible si no existe tabla
    }
}

function weekdayCode(d: Date, tz: string): HourRow["day"] {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(d);
    const w = (p.find(x => x.type === "weekday")?.value ?? "sun").toLowerCase().slice(0, 3);
    return (w as HourRow["day"]);
}

/**
 * Ventanas para un YYYY-MM-DD:
 * - Si hay exception con isOpen === false => cerrado.
 * - Si hay exception con horas (o isOpen === true) => usa esas horas.
 * - Si hay exception sin horas y sin cierre explícito => NO anula el día; cae a horarios base.
 */
function windowsForYMD(
    ymd: string,
    tz: string,
    hours: HourRow[],
    exceptions: ExceptionRow[]
) {
    const ex = exceptions.find(e => ymdInTZ(e.date, tz) === ymd);

    if (ex) {
        if (ex.isOpen === false) return []; // cierra explícitamente

        const hasPairs =
            (ex.start1 && ex.end1) ||
            (ex.start2 && ex.end2);

        if (hasPairs || ex.isOpen === true) {
            const pairs: [string | null, string | null][] = [
                [ex.start1, ex.end1],
                [ex.start2, ex.end2],
            ];
            return pairs
                .filter(([s, e]) => s && e)
                .map(([s, e]) => ({ start: hhmmWithOffset(s!), end: hhmmWithOffset(e!) }));
        }
        // excepción presente pero “vacía”: no bloquea → seguimos a base
    }

    const wd = weekdayCode(makeZonedDate(ymd, "00:00", tz), tz);
    const todays = hours.filter(h => h.day === wd && (h.isOpen ?? true));
    const pairs = todays
        .flatMap(h => [[h.start1, h.end1], [h.start2, h.end2]] as [string | null, string | null][])
        .filter(([s, e]) => s && e);

    return pairs.map(([s, e]) => ({ start: hhmmWithOffset(s!), end: hhmmWithOffset(e!) }));
}

async function isSlotFree(
    empresaId: number,
    start: Date,
    durationMin: number,
    bufferMin = 0,
    procedureId?: number | null
) {
    const startWithBuffer = new Date(start.getTime() - bufferMin * 60000);
    const endWithBuffer = new Date(start.getTime() + (durationMin + bufferMin) * 60000);
    const overlap = await prisma.appointment.count({
        where: {
            empresaId,
            deletedAt: null,
            status: { notIn: [AppointmentStatus.cancelled, AppointmentStatus.no_show] },
            AND: [{ startAt: { lt: endWithBuffer } }, { endAt: { gt: startWithBuffer } }],
        },
    });
    if (overlap > 0) return { ok: false };

    // dimensión staff (si no hay, ok)
    try {
        const staff = await fetchStaffSafe(empresaId);
        if (!staff.length) return { ok: true, staffId: undefined };
    } catch {
        return { ok: true, staffId: undefined };
    }

    // Para versión liviana: asumimos al menos un recurso disponible si no hay solapes de citas
    return { ok: true, staffId: undefined };
}

/* ======================= Tools reales ======================= */
async function toolListProcedures(ctx: EsteticaCtx, _args: any) {
    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId: ctx.empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, priceMin: true, priceMax: true },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        take: 6,
    });
    return { ok: true, items: rows };
}

async function resolveService(ctx: EsteticaCtx, q: { serviceId?: number; name?: string }) {
    if (q.serviceId) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { id: q.serviceId, empresaId: ctx.empresaId, enabled: true },
            select: { id: true, name: true, durationMin: true },
        });
        if (r) return r;
    }
    if (q.name && q.name.trim()) {
        const r = await prisma.esteticaProcedure.findFirst({
            where: { empresaId: ctx.empresaId, enabled: true, name: { contains: q.name.trim() } as any },
            select: { id: true, name: true, durationMin: true },
        });
        if (r) return r;
    }
    return null;
}

function intentWantsSlots(text: string) {
    const q = (text || "").toLowerCase();
    return /cita|agendar|agenda|horario|disponible|disponibilidad|mañana|tarde|noche|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|fecha|fechas/.test(q);
}

/** Busca slots usando horarios base + exceptions con correción de offset */
async function toolFindSlots(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }
) {
    const svc = await resolveService(ctx, { serviceId: args.serviceId, name: args.serviceName });
    const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    // Si no hay fecha, arrancamos en “mañana 06:00” local
    const hint = args.fromISO ? new Date(args.fromISO) : nextLocalMorning(ctx, 1);

    const tz = ctx.timezone;
    const ymd = ymdInTZ(hint, tz);

    const [hours, exceptions] = await Promise.all([
        fetchHours(ctx.empresaId),
        fetchExceptions(ctx.empresaId),
    ]);

    const wins = windowsForYMD(ymd, tz, hours, exceptions);

    const cap = Math.min(12, Math.max(6, Number(args.max ?? 8)));
    const raw: Array<{ start: Date }> = [];
    for (const w of wins) {
        let s = makeZonedDate(ymd, w.start, tz);
        const e = makeZonedDate(ymd, w.end, tz);
        while (s.getTime() + durationMin * 60000 <= e.getTime()) {
            const free = await isSlotFree(ctx.empresaId, s, durationMin, ctx.bufferMin, svc?.id ?? null);
            if ((free as any)?.ok) raw.push({ start: new Date(s) });
            if (raw.length >= cap) break;
            s = addMinutes(s, 15);
        }
        if (raw.length >= cap) break;
    }

    const future = raw.filter(d => d.start.getTime() > Date.now());
    const first = future[0];

    const labels = future.slice(0, 12).map((d, i) => ({
        idx: i + 1,
        startISO: d.start.toISOString(),
        startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(d.start),
        staffId: null as number | null,
    }));

    return {
        ok: true,
        durationMin,
        serviceName: svc?.name ?? args.serviceName ?? null,
        firstSuggestion: first
            ? {
                startISO: first.start.toISOString(),
                startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(first.start),
                staffId: null as number | null,
            }
            : null,
        slots: labels.slice(0, 6),
    };
}

async function toolBook(
    ctx: EsteticaCtx,
    args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number; staffId?: number },
    conversationId?: number
) {
    const phone = String(args.phone || "").replace(/[^\d]/g, "");
    if (!phone) return { ok: false, reason: "INVALID_PHONE" };

    const svc = await resolveService(ctx, { serviceId: args.serviceId, name: args.serviceName });
    if (!svc) return { ok: false, reason: "SERVICE_NOT_FOUND" };

    const durationMin = args.durationMin ?? svc.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;
    const startAt = new Date(args.startISO);
    const endAt = addMinutes(startAt, durationMin);

    const free = await isSlotFree(ctx.empresaId, startAt, durationMin, ctx.bufferMin, svc.id);
    if (!(free as any)?.ok) return { ok: false, reason: "CONFLICT_SLOT" };

    const status: AppointmentStatus = (ctx.rules?.requireConfirmation ?? true)
        ? AppointmentStatus.pending
        : AppointmentStatus.confirmed;

    const appt = await prisma.appointment.create({
        data: {
            empresaId: ctx.empresaId,
            conversationId: conversationId ?? null,
            source: AppointmentSource.ai,
            status,
            customerName: String(args.fullName || "").trim(),
            customerPhone: phone,
            customerDisplayName: String(args.fullName || "").trim(),
            serviceName: svc.name,
            serviceDurationMin: durationMin,
            startAt, endAt, timezone: ctx.timezone,
            procedureId: svc.id,
            notas: args.notes ?? null,
            locationNameCache: ctx.logistics?.locationName ?? null,
            staffId: args.staffId ?? null,
        },
    } as any);

    return {
        ok: true,
        data: {
            id: appt.id,
            startISO: appt.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(appt.startAt),
            status: appt.status,
            serviceName: appt.serviceName,
            staffId: appt.staffId ?? null,
        },
    };
}

async function toolReschedule(ctx: EsteticaCtx, args: { appointmentId: number; newStartISO: string; staffId?: number }) {
    const appt = await prisma.appointment.findUnique({ where: { id: Number(args.appointmentId) } } as any);
    if (!appt || appt.deletedAt || appt.empresaId !== ctx.empresaId) return { ok: false, reason: "NOT_FOUND" };
    const duration = appt.serviceDurationMin ?? Math.max(15, Math.round((+appt.endAt - +appt.startAt) / 60000));
    const newStart = new Date(args.newStartISO);
    const free = await isSlotFree(ctx.empresaId, newStart, duration, ctx.bufferMin, appt.procedureId ?? null);
    if (!(free as any)?.ok) return { ok: false, reason: "CONFLICT_SLOT" };
    const updated = await prisma.appointment.update({
        where: { id: appt.id },
        data: {
            startAt: newStart,
            endAt: addMinutes(newStart, duration),
            status: AppointmentStatus.rescheduled,
            staffId: args.staffId ?? appt.staffId ?? null,
        },
    } as any);
    return {
        ok: true,
        data: {
            id: updated.id,
            startISO: updated.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(updated.startAt),
            status: updated.status,
            staffId: updated.staffId ?? null,
        },
    };
}

async function toolCancel(ctx: EsteticaCtx, args: { appointmentId: number }) {
    const appt = await prisma.appointment.findUnique({ where: { id: Number(args.appointmentId) } } as any);
    if (!appt || appt.empresaId !== ctx.empresaId || appt.deletedAt) return { ok: false, reason: "NOT_FOUND" };
    const deleted = await prisma.appointment.update({
        where: { id: appt.id }, data: { status: AppointmentStatus.cancelled, deletedAt: new Date() },
    } as any);
    return {
        ok: true,
        data: {
            id: deleted.id,
            startISO: deleted.startAt.toISOString(),
            startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(deleted.startAt),
            status: deleted.status,
        },
    };
}

async function toolListUpcoming(ctx: EsteticaCtx, args: { phone: string; limit?: number }) {
    const phone = String(args.phone || "").replace(/[^\d]/g, "");
    if (!phone) return { ok: false, reason: "INVALID_PHONE" };
    const rows = await prisma.appointment.findMany({
        where: {
            empresaId: ctx.empresaId,
            customerPhone: phone,
            deletedAt: null,
            status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.rescheduled] },
            startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, serviceName: true, timezone: true },
        take: Math.max(1, Number(args.limit ?? 5)),
    } as any);
    const items = rows.map(r => ({
        id: r.id,
        startISO: r.startAt.toISOString(),
        startLabel: new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: r.timezone || ctx.timezone }).format(r.startAt),
        serviceName: r.serviceName ?? null,
    }));
    return { ok: true, items };
}

/* ======================= Tools spec/handlers ======================= */
export const toolSpecs = [
    { type: "function", function: { name: "listProcedures", description: "Lista breve de servicios/procedimientos disponibles.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "findSlots", description: "Busca horarios disponibles (máx. 6) y sugiere el primer cupo del día.", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, fromISO: { type: "string" }, max: { type: "number" } }, additionalProperties: false } } },
    { type: "function", function: { name: "book", description: "Crea una reserva confirmada/pending según política.", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, startISO: { type: "string" }, phone: { type: "string" }, fullName: { type: "string" }, notes: { type: "string" }, durationMin: { type: "number" }, staffId: { type: "number" } }, required: ["startISO", "phone", "fullName"], additionalProperties: false } } },
    { type: "function", function: { name: "reschedule", description: "Reagenda una cita existente.", parameters: { type: "object", properties: { appointmentId: { type: "number" }, newStartISO: { type: "string" }, staffId: { type: "number" } }, required: ["appointmentId", "newStartISO"], additionalProperties: false } } },
    { type: "function", function: { name: "cancel", description: "Cancela una cita por ID.", parameters: { type: "object", properties: { appointmentId: { type: "number" } }, required: ["appointmentId"], additionalProperties: false } } },
    { type: "function", function: { name: "listUpcomingApptsForPhone", description: "Lista próximas citas filtrando por teléfono.", parameters: { type: "object", properties: { phone: { type: "string" }, limit: { type: "number" } }, required: ["phone"], additionalProperties: false } } },
] as const;

export function toolHandlers(ctx: EsteticaCtx, convId?: number) {
    return {
        async listProcedures(_args: {}) { return toolListProcedures(ctx, _args); },
        async findSlots(args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
            return toolFindSlots(ctx, args);
        },
        async book(args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number; staffId?: number }) {
            return toolBook(ctx, args, convId);
        },
        async reschedule(args: { appointmentId: number; newStartISO: string; staffId?: number }) {
            return toolReschedule(ctx, args);
        },
        async cancel(args: { appointmentId: number }) { return toolCancel(ctx, args); },
        async listUpcomingApptsForPhone(args: { phone: string; limit?: number }) { return toolListUpcoming(ctx, args); },
    };
}

/* ======================= Prompt & fewshots ======================= */
export function systemPrompt(ctx: EsteticaCtx) {
    const tz = ctx.timezone;
    const allowSameDay = !!ctx.rules?.allowSameDay;
    const minNoticeH = ctx.rules?.minNoticeHours ?? 0;

    return [
        `Eres coordinador/a humano/a de una clínica estética premium en Colombia. Respondes cálido/a, cercano/a y natural, en 2–5 líneas, con **1 emoji** por turno. Nada de “voy a buscar / dame un momento”.`,
        `Usa **TOOLS** para todo lo de agenda: listar cupos, reservar, reagendar, cancelar, próximas.`,
        ``,
        `# Reglas de agenda`,
        `- Zona horaria del negocio: **${tz}**.`,
        `- Citas del mismo día: ${allowSameDay ? "permitidas si hay cupo" : "NO permitidas"}.`,
        `- Antelación mínima: **${minNoticeH}h**.`,
        `- Si el usuario no da fecha: **busca desde mañana 06:00 (${tz})** y **propón el primer cupo**; además muestra 2–3 alternativas del mismo día.`,
        `- Solo ofrece horarios que devuelven las tools (máx. 6 por respuesta).`,
        ``,
        `# Interpretación de fechas del usuario`,
        `- “mañana / pasado / martes / la otra semana / 3pm del lunes”: conviértelo a fecha/hora real en ${tz} y pásalo como **fromISO** a **findSlots**.`,
        ``,
        `# Flujo de reserva (full agent)`,
        `1) Detecta el servicio. 2) Propón el primer cupo y 2–3 alternos. 3) Pide nombre completo y teléfono. 4) **Doble confirmación**: resume y pregunta “¿Confirmamos?”. Solo si la respuesta es clara (sí/ok/dale/listo/confirmo), llama **book**.`,
        ``,
        `# Estilo`,
        `- Saludo natural y útil: NO digas que el cliente “no tiene cita” salvo que lo pregunte.`,
        `- Evita frases tipo “un momento”, “procedo a…”; escribe como persona real.`,
    ].join("\n");
}

export function buildFewshots(_ctx: EsteticaCtx): ChatTurn[] {
    return [
        { role: "user", content: "hola" },
        { role: "assistant", content: "¡Hola! ¿Quieres ver horarios o resolver una duda de tratamientos? 🙂" },

        { role: "user", content: "me sirve el martes en la tarde para botox" },
        { role: "assistant", content: "Perfecto, miro cupos desde ese *martes* y te propongo el primero disponible en la tarde y 2–3 opciones más. 😉" },
    ];
}

/* ======================= Orquestación LLM ======================= */
async function runTools(ctx: EsteticaCtx, calls: AssistantMsg["tool_calls"], convId?: number) {
    const handlers = toolHandlers(ctx, convId);
    const out: ToolMsg[] = [];
    for (const c of calls || []) {
        const args = safeParseArgs(c.function?.arguments);
        let res: any;
        try { res = await (handlers as any)[c.function.name](args); }
        catch (e: any) { res = { ok: false, error: e?.message || "TOOL_ERROR" }; }
        out.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(res ?? null) });
    }
    return out;
}

export async function runEsteticaAgent(
    ctx: EsteticaCtx & { __conversationId?: number },
    turns: ChatTurn[],
): Promise<string> {
    const sys = systemPrompt(ctx);
    const few = buildFewshots(ctx);
    const kb = (await ctx.buildKbContext?.()) ?? "";

    const base: any = [
        { role: "system", content: `${sys}\n\n### Conocimiento de la clínica\n${kb}` },
        ...few,
        ...turns,
    ];

    // Pase 1
    const r1 = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: base,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);
    const m1 = (r1.choices?.[0]?.message || {}) as AssistantMsg;

    if (DEBUG) {
        console.log("[AGENT] model=", MODEL, "tool_calls=", Array.isArray(m1.tool_calls) ? m1.tool_calls.length : 0);
        if (!m1.tool_calls?.length && m1.content) {
            console.log("[AGENT] no-tools content preview:", String(m1.content).slice(0, 160));
        }
    }

    // Tools
    if (Array.isArray(m1.tool_calls) && m1.tool_calls.length) {
        const toolMsgs = await runTools(ctx, m1.tool_calls, ctx.__conversationId);
        const r2 = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [...base, m1 as any, ...toolMsgs] as any,
        } as any);
        const final = r2.choices?.[0]?.message?.content?.trim() || "";
        return postProcessReply(final || "¿Te comparto el primer horario disponible desde mañana o prefieres resolver una duda específica?", turns);
    }

    // ============ Fallback proactivo ============
    const lastUser = [...turns].reverse().find(t => t.role === "user")?.content || "";
    if (intentWantsSlots(lastUser)) {
        try {
            const forced = await toolFindSlots(ctx, { serviceName: undefined, fromISO: undefined, max: 8 });
            if (DEBUG) console.log("[AGENT][fallback] forced findSlots ->", forced?.slots?.length || 0, "slots");
            if (forced?.ok && forced?.slots?.length) {
                const lines = forced.slots.map((s: any) => `${s.idx}️⃣ ${s.startLabel}`).slice(0, 6);
                const head = forced.firstSuggestion ? `Tengo estos cupos disponibles, por ejemplo **${forced.firstSuggestion.startLabel}**:\n` : `Estos son los cupos disponibles:\n`;
                const msg = `${head}${lines.join("\n")}\n\nSi te sirve alguno, me confirmas tu *nombre completo* y *teléfono* para apartarlo.`;
                return postProcessReply(msg, turns);
            }
            return postProcessReply("Puedo revisar opciones desde mañana y proponerte los primeros cupos del día. ¿Quieres que los consulte?", turns);
        } catch (e: any) {
            if (DEBUG) console.warn("[AGENT][fallback] error forcing findSlots:", e?.message || e);
        }
    }

    // Sin tools y sin intención clara de agenda → responde normal
    const txt = (m1.content || "").trim();
    return postProcessReply(txt || "¿Te comparto horarios desde mañana o prefieres info de los tratamientos?", turns);
}

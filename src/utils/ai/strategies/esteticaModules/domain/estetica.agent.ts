// utils/ai/strategies/esteticaModules/domain/estetica.agent.ts
// Full-agent natural: agenda contra DB, extracción por historial y doble confirmación.
// Sin “botty” ni relistar: solo propone cuando hace falta, y confirma cuando ya hay todo.

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

/* ========== Memoria volátil (últimos slots útiles) ========== */
type RememberedSlot = { idx: number; startISO: string; startLabel: string; staffId: number | null };
const lastSlots = new Map<number, RememberedSlot[]>();
function rememberSlots(convId: number | undefined, slots?: RememberedSlot[]) {
    if (!convId || !slots?.length) return;
    lastSlots.set(convId, slots.slice(0, 6));
}
function readSlots(convId: number | undefined): RememberedSlot[] {
    if (!convId) return [];
    return lastSlots.get(convId) || [];
}

/* ======================= Utils ======================= */
const ENDINGS = ["¿Te parece?", "¿Confirmamos?", "¿Te va bien?"];
function postProcessReply(reply: string, history: ChatTurn[]): string {
    const clean = (reply || "").trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (!clean) return clean;
    const add = ENDINGS[history.length % ENDINGS.length];
    const withEnding = /[.?!…]$/.test(clean) ? `${clean} ${add}` : `${clean}. ${add}`;
    const hasEmoji = /\p{Extended_Pictographic}/u.test(withEnding);
    return hasEmoji ? withEnding : `${withEnding} 🙂`;
}
function safeParseArgs(raw?: string) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const onlyDigits = (s: string) => (s || "").replace(/[^\d]/g, "");

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
function nextLocalMorning(ctx: EsteticaCtx, daysAhead = 1): Date {
    const tz = ctx.timezone;
    const base = addDays(new Date(), daysAhead);
    return makeZonedDate(ymdInTZ(base, tz), "06:00", tz);
}

/* ====== (Opcional) offset si tus AppointmentHour están en UTC ====== */
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
async function isSlotFree(empresaId: number, start: Date, durationMin: number, bufferMin = 0, _procedureId?: number | null) {
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
    // Staff-awareness liviano: si no hay staff → ok
    try {
        const staff = await prisma.staff.findMany({
            where: { empresaId, OR: [{ active: true }, { active: null }] },
            select: { id: true }, take: 1,
        } as any);
        if (!staff.length) return { ok: true, staffId: undefined };
    } catch { return { ok: true, staffId: undefined }; }
    return { ok: true, staffId: undefined };
}

/* ======================= Tools reales ======================= */
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
async function toolListProcedures(ctx: EsteticaCtx) {
    const rows = await prisma.esteticaProcedure.findMany({
        where: { empresaId: ctx.empresaId, enabled: true },
        select: { id: true, name: true, durationMin: true, priceMin: true, priceMax: true },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        take: 10,
    });
    return { ok: true, items: rows };
}

function intentWantsSlots(text: string) {
    const q = norm(text);
    return /cita|agendar|agenda|horario|disponible|disponibilidad|mañana|tarde|noche|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo/.test(q);
}
function intentWantsServices(text: string) {
    const q = norm(text);
    return /(servicio|servicios|tratamiento|tratamientos)\??$/i.test(q) || q.includes("que servicios");
}

async function toolFindSlots(ctx: EsteticaCtx, args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
    const svc = await resolveService(ctx, { serviceId: args.serviceId, name: args.serviceName });
    const durationMin = svc?.durationMin ?? ctx.rules?.defaultServiceDurationMin ?? 60;

    const hint = args.fromISO ? new Date(args.fromISO) : nextLocalMorning(ctx, 1);

    const tz = ctx.timezone;
    const ymd = ymdInTZ(hint, tz);

    const hours = await prisma.appointmentHour.findMany({
        where: { empresaId: ctx.empresaId, isOpen: true },
        select: { day: true, start1: true, end1: true, start2: true, end2: true },
    });

    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
        .formatToParts(makeZonedDate(ymd, "00:00", tz))
        .find(p => p.type === "weekday")?.value?.toLowerCase()
        ?.slice(0, 3) as "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

    const todays = hours.filter(h => h.day === weekday);
    const pairs = todays.flatMap(h => [[h.start1, h.end1], [h.start2, h.end2]] as [string | null, string | null][])
        .filter(([s, e]) => s && e)
        .map(([s, e]) => ({ start: hhmmWithOffset(s!), end: hhmmWithOffset(e!) }));

    const raw: Array<{ start: Date }> = [];
    for (const w of pairs) {
        let s = makeZonedDate(ymd, w.start, tz);
        const e = makeZonedDate(ymd, w.end, tz);
        while (s.getTime() + durationMin * 60000 <= e.getTime()) {
            const free = await isSlotFree(ctx.empresaId, s, durationMin, ctx.bufferMin, svc?.id ?? null);
            if ((free as any)?.ok) raw.push({ start: new Date(s) });
            if (raw.length >= Math.min(12, Math.max(6, Number(args.max ?? 8)))) break;
            s = addMinutes(s, 15);
        }
        if (raw.length >= Math.min(12, Math.max(6, Number(args.max ?? 8)))) break;
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
    const phone = onlyDigits(String(args.phone || ""));
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

/* ======================= Tools spec/handlers ======================= */
export const toolSpecs = [
    { type: "function", function: { name: "listProcedures", description: "Lista de servicios/procedimientos.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "findSlots", description: "Busca horarios disponibles (máx. 6) y sugiere el primero.", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, fromISO: { type: "string" }, max: { type: "number" } }, additionalProperties: false } } },
    { type: "function", function: { name: "book", description: "Crea la reserva.", parameters: { type: "object", properties: { serviceId: { type: "number" }, serviceName: { type: "string" }, startISO: { type: "string" }, phone: { type: "string" }, fullName: { type: "string" }, notes: { type: "string" }, durationMin: { type: "number" }, staffId: { type: "number" } }, required: ["startISO", "phone", "fullName"], additionalProperties: false } } },
] as const;

export function toolHandlers(ctx: EsteticaCtx, convId?: number) {
    return {
        async listProcedures(_args: {}) { return toolListProcedures(ctx); },
        async findSlots(args: { serviceId?: number; serviceName?: string; fromISO?: string; max?: number }) {
            return toolFindSlots(ctx, args);
        },
        async book(args: { serviceId?: number; serviceName?: string; startISO: string; phone: string; fullName: string; notes?: string; durationMin?: number; staffId?: number }) {
            return toolBook(ctx, args, convId);
        },
    };
}

/* ======================= Prompt cortito (estilo humano) ======================= */
export function systemPrompt(ctx: EsteticaCtx) {
    const tz = ctx.timezone;
    const allowSameDay = !!ctx.rules?.allowSameDay;
    const minNoticeH = ctx.rules?.minNoticeHours ?? 0;
    const who = ctx as any;
    const brand = who?.businessName ? `de *${who.businessName}*` : "de la clínica";

    return [
        `Eres coordinador/a humano/a ${brand}. Respondes cálido/a, directo/a, en 2–5 líneas y 1 emoji. Nada de “estoy buscando” o “soy IA”.`,
        `Usa TOOLS solo para disponibilidad/booking. No inventes horarios.`,
        `Zona horaria: ${tz}. Mismo día: ${allowSameDay ? "sí" : "no"}. Antelación mínima: ${minNoticeH}h.`,
        `Si falta un dato para cerrar (nombre, teléfono o horario), pide SOLO ese dato.`,
        `Cuando ya tengas servicio + horario + nombre + teléfono, arma un resumen claro y pregunta: “¿Confirmamos?”. Solo si el cliente confirma explícitamente, llama book.`,
    ].join("\n");
}
export function buildFewshots(ctx: EsteticaCtx): ChatTurn[] {
    const brand = (ctx as any)?.businessName;
    const hi = brand ? `¡Hola! Soy coordinación de ${brand}.` : "¡Hola!";
    return [
        { role: "user", content: "hola" },
        { role: "assistant", content: `${hi} ¿Buscas horarios o prefieres resolver una duda rápida del tratamiento? 🙂` },
    ];
}

/* ======================= Extractores por historial ======================= */
const YES_RE = /\b(si|sí|dale|ok|okay|listo|confirmo|confirmamos|perfecto)\b/i;

async function detectServiceFromHistory(ctx: EsteticaCtx, turns: ChatTurn[]) {
    const procs = await prisma.esteticaProcedure.findMany({
        where: { empresaId: ctx.empresaId, enabled: true },
        select: { id: true, name: true }, take: 30,
    });
    const body = norm(turns.map(t => t.content).join(" "));
    let hit = null as { id: number; name: string } | null;
    for (const p of procs) {
        if (body.includes(norm(p.name))) { hit = p; break; }
    }
    return hit;
}
function detectPhoneFromHistory(turns: ChatTurn[]): string | null {
    const body = turns.filter(t => t.role === "user").map(t => t.content).reverse();
    for (const txt of body) {
        const m = txt.replace(/\s/g, " ").match(/\+?\d[\d\s().-]{7,}/);
        if (m) return onlyDigits(m[0]);
    }
    return null;
}
function detectNameFromHistory(turns: ChatTurn[]): string | null {
    const lines = turns.filter(t => t.role === "user").map(t => t.content);
    for (const s of lines) {
        const m1 = s.match(/me llamo\s+([a-záéíóúñ ]{3,60})/i);
        if (m1) return m1[1].replace(/\s+/g, " ").trim().replace(/[^ a-zA-ZÁÉÍÓÚÑáéíóúñ'.-]/g, "");
        const m2 = s.match(/\bsoy\s+([a-záéíóúñ ]{3,60})/i);
        if (m2) return m2[1].replace(/\s+/g, " ").trim();
        const clean = s.replace(/[^\p{L}\s'.-]/gu, " ").trim();
        if (clean.split(/\s+/).length >= 2 && clean.split(/\s+/).length <= 4 && /^[\p{L}'.-]+(\s[\p{L}'.-]+){1,3}$/u.test(clean)) {
            return clean;
        }
    }
    return null;
}
function parsePickIndexOrTime(text: string): { pickIdx?: number; hhmm?: string } {
    const t = norm(text);
    const idxMatch = t.match(/(?:opcion|opción)?\s*([1-6])\b/) || t.match(/^\s*([1-6])\s*$/);
    if (idxMatch) return { pickIdx: Number(idxMatch[1]) };
    const hm = t.match(/\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
    if (hm) {
        let H = Number(hm[1]); const M = hm[2]; const ap = (hm[3] || "").toLowerCase().replace(/\./g, "");
        if (ap === "pm" && H < 12) H += 12;
        if (ap === "am" && H === 12) H = 0;
        return { hhmm: `${String(H).padStart(2, "0")}:${M}` };
    }
    return {};
}
function detectSlotFromHistory(ctx: EsteticaCtx & { __conversationId?: number }, turns: ChatTurn[]) {
    const mem = readSlots(ctx.__conversationId);
    const lastUser = [...turns].reverse().find(t => t.role === "user")?.content || "";
    if (mem.length) {
        const { pickIdx, hhmm } = parsePickIndexOrTime(lastUser);
        if (pickIdx && pickIdx >= 1 && pickIdx <= mem.length) return mem[pickIdx - 1];
        if (hhmm) {
            const hit = mem.find(s => s.startLabel.includes(hhmm));
            if (hit) return hit;
        }
    }
    return null;
}
function lastAssistantAskedConfirmation(turns: ChatTurn[]): boolean {
    const lastA = [...turns].reverse().find(t => t.role === "assistant")?.content || "";
    return /¿confirmamos\??/i.test(lastA);
}
function userJustConfirmed(turns: ChatTurn[]): boolean {
    const lastU = [...turns].reverse().find(t => t.role === "user")?.content || "";
    return YES_RE.test(lastU);
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

    // ===== 1) Intento determinista: ¿ya tengo todo para doble confirmación? =====
    const svc = await detectServiceFromHistory(ctx, turns);
    const phone = detectPhoneFromHistory(turns);
    const fullName = detectNameFromHistory(turns);
    const chosen = detectSlotFromHistory(ctx, turns);

    if (lastAssistantAskedConfirmation(turns) && userJustConfirmed(turns) && svc && phone && fullName && chosen?.startISO) {
        const booked = await toolBook(ctx, {
            serviceId: svc.id, serviceName: svc.name,
            startISO: chosen.startISO, phone, fullName,
        }, ctx.__conversationId);
        if (booked?.ok) {
            const label = booked.data.startLabel;
            const msg = `¡Listo! Reservé *${booked.data.serviceName}* para **${label}** a nombre de *${fullName}*. Te llegará la confirmación por este medio. 🎉`;
            return msg;
        }
        return postProcessReply("Ese cupo acaba de ocuparse. ¿Busco otra hora cercana el mismo día u otro día?", turns);
    }

    if (svc && phone && fullName && chosen?.startISO && !lastAssistantAskedConfirmation(turns)) {
        const label = chosen.startLabel;
        const resum = `Quedaría así:\n• Servicio: *${svc.name}*\n• Fecha y hora: **${label}**\n• A nombre de: *${fullName}*\n• Teléfono: *${phone}*\n¿Confirmamos para agendar?`;
        return postProcessReply(resum, turns);
    }

    // ===== 2) Si falta algún dato, pedimos SOLO lo que falta (estilo humano) =====
    const missing: string[] = [];
    if (!svc) missing.push("servicio");
    if (!chosen?.startISO) missing.push("horario");
    if (!fullName) missing.push("nombre");
    if (!phone) missing.push("teléfono");

    if (missing.length) {
        const lastUser = [...turns].reverse().find(t => t.role === "user")?.content || "";

        // Si preguntó por servicios → listar desde la BD
        if (intentWantsServices(lastUser)) {
            const list = await toolListProcedures(ctx);
            const items = (list.items || []).slice(0, 6).map((i: any) => `• ${i.name}`).join("\n");
            const trail = missing.length > 1 ? "\n\nSi te interesa alguno, me dices a nombre de quién sería y vemos horarios." : "";
            return postProcessReply(`Claro, estos son algunos de nuestros tratamientos:\n${items}${trail}`, turns);
        }

        // Si falta horario y quiere ver disponibilidad → slots
        const needsSlots = missing.includes("horario") && intentWantsSlots(lastUser);
        if (needsSlots) {
            const forced = await toolFindSlots(ctx, { max: 8 });
            if (forced?.ok && forced?.slots?.length) {
                rememberSlots(ctx.__conversationId, forced.slots as any);
                const head = forced.firstSuggestion
                    ? `Tengo estos cupos disponibles, por ejemplo **${forced.firstSuggestion.startLabel}**:\n`
                    : `Estos son los cupos disponibles:\n`;
                const lines = forced.slots.map((s: any) => `${s.idx}️⃣ ${s.startLabel}`).slice(0, 6).join("\n");
                const still = missing.filter(m => m !== "horario");
                const tail = still.length ? `\n\nY para agendar, ${still.length === 2 ? still.join(" y ") : still.join(", ")}.` : `\n\nElige una opción (1–6).`;
                return postProcessReply(`${head}${lines}${tail}`, turns);
            }
            return postProcessReply("Puedo revisar opciones desde mañana y proponerte los primeros cupos del día. ¿Quieres que los consulte?", turns);
        }

        // Pedidos puntuales
        if (missing.length === 1 && missing[0] === "nombre")
            return postProcessReply("¿A nombre de quién agendo? (nombre completo)", turns);
        if (missing.length === 1 && missing[0] === "teléfono")
            return postProcessReply("¿Me compartes tu número de teléfono para dejarte la confirmación por aquí?", turns);
        if (missing.length === 1 && missing[0] === "servicio") {
            const list = await toolListProcedures(ctx);
            const items = (list.items || []).slice(0, 5).map((i: any) => `• ${i.name}`).join("\n");
            return postProcessReply(`¿Qué tratamiento te gustaría agendar?\n${items}`, turns);
        }

        // Faltan varios
        return postProcessReply("Te ayudo a agendar. ¿Qué tratamiento quieres y a nombre de quién sería? Si ya tienes un horario en mente, me dices.", turns);
    }

    // ===== 3) Si no faltan datos pero tampoco confirmación → LLM libre con tools
    const sys = systemPrompt(ctx);
    const few = buildFewshots(ctx);
    const kb = (await (ctx as any).buildKbContext?.()) ?? "";
    const base: any = [
        { role: "system", content: `${sys}\n\n### Conocimiento de la clínica\n${kb}` },
        ...few,
        ...turns,
    ];

    const r1 = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages: base,
        tools: toolSpecs as any,
        tool_choice: "auto",
    } as any);
    const m1 = (r1.choices?.[0]?.message || {}) as AssistantMsg;

    // Si ejecutó tools (lista/slots) guardamos slots si aplica y cerramos con estilo humano
    if (Array.isArray(m1.tool_calls) && m1.tool_calls.length) {
        const toolMsgs = await runTools(ctx, m1.tool_calls, ctx.__conversationId);
        for (const c of m1.tool_calls) {
            if (c.function?.name === "findSlots") {
                try {
                    const res = safeParseArgs(toolMsgs.find(t => t.tool_call_id === c.id)?.content || "");
                    if (res?.ok && Array.isArray(res?.slots)) rememberSlots(ctx.__conversationId, res.slots);
                } catch { /* ignore */ }
            }
        }
        const r2 = await openai.chat.completions.create({
            model: MODEL,
            temperature: TEMPERATURE,
            messages: [...base, m1 as any, ...toolMsgs] as any,
        } as any);
        const final = r2.choices?.[0]?.message?.content?.trim() || "";
        return postProcessReply(final || "¿Te comparto el primer horario disponible desde mañana o prefieres resolver una duda específica?", turns);
    }

    // Fallback sobrio
    const text = (m1.content || "").trim();
    if (text) return postProcessReply(text, turns);

    return postProcessReply("¿Prefieres que te pase horarios o resolvemos primero alguna duda del tratamiento?", turns);
}

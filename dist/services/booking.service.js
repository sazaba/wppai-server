"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookAppointment = bookAppointment;
exports.rescheduleAppointment = rescheduleAppointment;
exports.cancelAppointment = cancelAppointment;
// src/services/booking.service.ts
const prisma_1 = __importDefault(require("../lib/prisma"));
const _availability_1 = require("../controllers/_availability");
const luxon_1 = require("luxon");
/* ============================================
   Utils internos
============================================ */
function getWeekdayKey(dt) {
    // Luxon: Monday=1..Sunday=7
    const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    return map[dt.weekday % 7];
}
/** Verifica si el rango [start,end] cae dentro de los bloques abiertos del día (en TZ de negocio). */
async function isWithinWorkingHours(empresaId, tz, startAt, endAt) {
    const startLocal = luxon_1.DateTime.fromJSDate(startAt).setZone(tz);
    const endLocal = luxon_1.DateTime.fromJSDate(endAt).setZone(tz);
    if (!startLocal.isValid || !endLocal.isValid || endLocal <= startLocal)
        return false;
    const dayKey = getWeekdayKey(startLocal);
    // Si cruza de día, lo rechazamos (para MVP). Puedes ampliar si requieres.
    if (getWeekdayKey(endLocal) !== dayKey)
        return false;
    const row = await prisma_1.default.appointmentHour.findUnique({
        where: { empresaId_day: { empresaId, day: dayKey } },
        select: { isOpen: true, start1: true, end1: true, start2: true, end2: true },
    });
    if (!row || !row.isOpen)
        return false;
    const mkIv = (s, e) => {
        if (!s || !e)
            return null;
        const [sh, sm] = s.split(":").map(Number);
        const [eh, em] = e.split(":").map(Number);
        const sdt = startLocal.startOf("day").set({ hour: sh, minute: sm });
        const edt = startLocal.startOf("day").set({ hour: eh, minute: em });
        if (!sdt.isValid || !edt.isValid || edt <= sdt)
            return null;
        return luxon_1.Interval.fromDateTimes(sdt, edt);
    };
    const b1 = mkIv(row.start1, row.end1);
    const b2 = mkIv(row.start2, row.end2);
    const slot = luxon_1.Interval.fromDateTimes(startLocal, endLocal);
    return !!((b1 && b1.contains(slot.start) && b1.contains(slot.end)) ||
        (b2 && b2.contains(slot.start) && b2.contains(slot.end)));
}
/* ============================================
   API de servicio
============================================ */
async function bookAppointment(params) {
    const { empresaId, conversationId, customerName, customerPhone, serviceName, startsAt, endsAt, notas = null, enforceWorkingHours = true, } = params;
    // 1) Config del negocio
    const cfg = await prisma_1.default.businessConfig.findUnique({ where: { empresaId } });
    if (!cfg)
        return { ok: false, error: "Config de negocio no encontrada." };
    if (!cfg.appointmentEnabled)
        return { ok: false, error: "La agenda no está habilitada para este negocio." };
    const tz = cfg.appointmentTimezone || "America/Bogota";
    const bufferMin = cfg.appointmentBufferMin ?? 10;
    // 2) Normalizar tiempo y validar
    const start = luxon_1.DateTime.fromJSDate(startsAt);
    const end = luxon_1.DateTime.fromJSDate(endsAt);
    if (!start.isValid || !end.isValid)
        return { ok: false, error: "Fecha/hora inválida." };
    if (end <= start)
        return { ok: false, error: "El fin debe ser mayor al inicio." };
    // 3) Validar que el slot cae dentro de los horarios abiertos (opcional)
    if (enforceWorkingHours) {
        const inside = await isWithinWorkingHours(empresaId, tz, start.toJSDate(), end.toJSDate());
        if (!inside)
            return { ok: false, error: "La hora seleccionada está fuera del horario de atención." };
    }
    // 4) Chequeo de solapes con buffer
    const checkStart = start.minus({ minutes: bufferMin }).toJSDate();
    const checkEnd = end.plus({ minutes: bufferMin }).toJSDate();
    const conflict = await (0, _availability_1.hasOverlap)({ empresaId, startAt: checkStart, endAt: checkEnd });
    if (conflict)
        return { ok: false, error: "Ese horario ya está ocupado." };
    // 5) Transacción con re-chequeo (evita carrera)
    try {
        const created = await prisma_1.default.$transaction(async (tx) => {
            const again = await tx.appointment.findFirst({
                where: {
                    empresaId,
                    AND: [{ startAt: { lt: checkEnd } }, { endAt: { gt: checkStart } }],
                },
                select: { id: true },
            });
            if (again)
                throw new Error("Horario ocupado (race).");
            return tx.appointment.create({
                data: {
                    empresaId,
                    conversationId: conversationId ?? null,
                    source: "client", // ajusta si tu flujo define otra fuente
                    status: "pending", // o "confirmed" si confirmas en un paso
                    customerName,
                    customerPhone,
                    serviceName,
                    notas,
                    startAt: start.toJSDate(), // guarda UTC
                    endAt: end.toJSDate(),
                    timezone: tz,
                },
            });
        });
        return { ok: true, id: created.id, when: created.startAt, tz };
    }
    catch (e) {
        return { ok: false, error: e?.message || "No se pudo crear la cita." };
    }
}
async function rescheduleAppointment(params) {
    const { empresaId, appointmentId, startsAt, endsAt, enforceWorkingHours = true } = params;
    const cfg = await prisma_1.default.businessConfig.findUnique({ where: { empresaId } });
    if (!cfg)
        return { ok: false, error: "Config de negocio no encontrada." };
    const tz = cfg.appointmentTimezone || "America/Bogota";
    const bufferMin = cfg.appointmentBufferMin ?? 10;
    const start = luxon_1.DateTime.fromJSDate(startsAt);
    const end = luxon_1.DateTime.fromJSDate(endsAt);
    if (!start.isValid || !end.isValid || end <= start)
        return { ok: false, error: "Rango de fechas inválido." };
    if (enforceWorkingHours) {
        const inside = await isWithinWorkingHours(empresaId, tz, start.toJSDate(), end.toJSDate());
        if (!inside)
            return { ok: false, error: "La hora seleccionada está fuera del horario de atención." };
    }
    const checkStart = start.minus({ minutes: bufferMin }).toJSDate();
    const checkEnd = end.plus({ minutes: bufferMin }).toJSDate();
    // Evitar solape con otras citas (excluyendo la misma)
    const conflict = await prisma_1.default.appointment.findFirst({
        where: {
            empresaId,
            NOT: { id: appointmentId },
            AND: [{ startAt: { lt: checkEnd } }, { endAt: { gt: checkStart } }],
        },
        select: { id: true },
    });
    if (conflict)
        return { ok: false, error: "Horario ocupado." };
    await prisma_1.default.appointment.update({
        where: { id: appointmentId },
        data: { startAt: start.toJSDate(), endAt: end.toJSDate() },
    });
    return { ok: true };
}
async function cancelAppointment(empresaId, appointmentId) {
    const row = await prisma_1.default.appointment.findUnique({ where: { id: appointmentId } });
    if (!row || row.empresaId !== empresaId)
        return { ok: false, error: "Cita no encontrada." };
    await prisma_1.default.appointment.update({
        where: { id: appointmentId },
        data: { status: "cancelled" },
    });
    return { ok: true };
}

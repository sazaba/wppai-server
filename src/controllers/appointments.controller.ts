import { Request, Response } from "express";
import prisma from '../lib/prisma'
import { hasOverlap } from "./_availability";

function parseDateParam(v?: string | string[]) {
    if (!v) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    const d = new Date(s);
    return Number.isNaN(+d) ? undefined : d;
}

// GET /api/appointments?from=&to=&sedeId=&serviceId=&providerId=
export async function listAppointments(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const { sedeId, serviceId, providerId } = req.query;

    const from = parseDateParam(req.query.from as any);
    const to = parseDateParam(req.query.to as any);

    const AND: any[] = [{ empresaId }];
    if (from && to) AND.push({ startAt: { gte: from }, endAt: { lte: to } });
    if (sedeId) AND.push({ sedeId: Number(sedeId) });
    if (serviceId) AND.push({ serviceId: Number(serviceId) });
    if (providerId) AND.push({ providerId: Number(providerId) });

    const data = await prisma.appointment.findMany({
        where: { AND },
        orderBy: { startAt: "asc" },
        select: {
            id: true, empresaId: true,
            sedeId: true, serviceId: true, providerId: true, conversationId: true,
            source: true, status: true,
            customerName: true, customerPhone: true, serviceName: true, notas: true,
            startAt: true, endAt: true, timezone: true,
        },
    });

    res.json(data);
}

// POST /api/appointments
export async function createAppointment(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const {
        sedeId, serviceId, providerId, conversationId,
        source, status,
        customerName, customerPhone, serviceName, notas,
        startAt, endAt, timezone,
    } = req.body;

    if (!customerName || !customerPhone || !serviceName || !startAt || !endAt) {
        return res.status(400).json({ error: "Campos requeridos: customerName, customerPhone, serviceName, startAt, endAt" });
    }

    const start = new Date(startAt);
    const end = new Date(endAt);
    if (!(start < end)) return res.status(400).json({ error: "startAt debe ser menor que endAt" });

    const overlap = await hasOverlap({
        empresaId,
        sedeId: sedeId ? Number(sedeId) : undefined,
        providerId: providerId ? Number(providerId) : undefined,
        startAt: start,
        endAt: end,
    });
    if (overlap) return res.status(409).json({ error: "Existe otra cita en ese intervalo" });

    const appt = await prisma.appointment.create({
        data: {
            empresaId,
            sedeId: sedeId ? Number(sedeId) : null,
            serviceId: serviceId ? Number(serviceId) : null,
            providerId: providerId ? Number(providerId) : null,
            conversationId: conversationId ? Number(conversationId) : null,
            source: source ?? "client",
            status: status ?? "pending",
            customerName,
            customerPhone,
            serviceName,
            notas: notas ?? null,
            startAt: start,
            endAt: end,
            timezone: timezone || "America/Bogota",
        },
    });

    res.status(201).json(appt);
}

// PUT /api/appointments/:id
export async function updateAppointment(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const id = Number(req.params.id);
    const patch = req.body;

    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing || existing.empresaId !== empresaId) return res.status(404).json({ error: "No encontrado" });

    let start = existing.startAt;
    let end = existing.endAt;

    if (patch.startAt) start = new Date(patch.startAt);
    if (patch.endAt) end = new Date(patch.endAt);
    if (!(start < end)) return res.status(400).json({ error: "startAt debe ser menor que endAt" });

    // check overlap si cambian ventana o recursos
    const changedWindow = patch.startAt || patch.endAt || patch.sedeId || patch.providerId;
    if (changedWindow) {
        const overlap = await hasOverlap({
            empresaId,
            sedeId: patch.sedeId ?? existing.sedeId ?? undefined,
            providerId: patch.providerId ?? existing.providerId ?? undefined,
            startAt: start,
            endAt: end,
            ignoreId: id,
        });
        if (overlap) return res.status(409).json({ error: "Existe otra cita en ese intervalo" });
    }

    const appt = await prisma.appointment.update({
        where: { id },
        data: {
            sedeId: patch.sedeId ?? existing.sedeId,
            serviceId: patch.serviceId ?? existing.serviceId,
            providerId: patch.providerId ?? existing.providerId,
            conversationId: patch.conversationId ?? existing.conversationId,
            source: patch.source ?? existing.source,
            status: patch.status ?? existing.status,
            customerName: patch.customerName ?? existing.customerName,
            customerPhone: patch.customerPhone ?? existing.customerPhone,
            serviceName: patch.serviceName ?? existing.serviceName,
            notas: patch.notas ?? existing.notas,
            startAt: start,
            endAt: end,
            timezone: patch.timezone ?? existing.timezone,
        },
    });

    res.json(appt);
}

// PUT /api/appointments/:id/status
export async function updateAppointmentStatus(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const id = Number(req.params.id);
    const { status } = req.body as { status: any };
    if (!status) return res.status(400).json({ error: "status requerido" });

    const appt = await prisma.appointment.update({
        where: { id },
        data: { status },
    });
    if (appt.empresaId !== empresaId) return res.status(403).json({ error: "forbidden" });
    res.json(appt);
}

// DELETE /api/appointments/:id
export async function deleteAppointment(req: Request, res: Response) {
    const empresaId = (req as any).empresaId as number;
    const id = Number(req.params.id);

    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt || appt.empresaId !== empresaId) return res.status(404).json({ error: "No encontrado" });

    await prisma.appointment.delete({ where: { id } });
    res.json({ ok: true });
}

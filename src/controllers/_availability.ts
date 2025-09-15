// src/controllers/_availability.ts
import prisma from '../lib/prisma'

export async function hasOverlap(params: {
    empresaId: number;
    sedeId?: number | null;
    providerId?: number | null;
    startAt: Date;
    endAt: Date;
    ignoreId?: number;
}) {
    const { empresaId, sedeId, providerId, startAt, endAt, ignoreId } = params;

    // armamos condiciones: por empresa + (sede/proveedor si vienen)
    const AND: any[] = [
        { empresaId },
        {
            OR: [
                // [a..b] se solapa con [x..y] si a < y && b > x
                { startAt: { lt: endAt }, endAt: { gt: startAt } },
            ],
        },
    ];
    if (sedeId) AND.push({ sedeId });
    if (providerId) AND.push({ providerId });

    const conflict = await prisma.appointment.findFirst({
        where: {
            AND,
            ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
            status: { not: "cancelled" },
        },
        select: { id: true },
    });

    return Boolean(conflict);
}

// src/controllers/_availability.ts
import prisma from "../lib/prisma";

export async function hasOverlap(params: {
    empresaId: number;
    sedeId?: number | null;
    providerId?: number | null;
    startAt: Date;
    endAt: Date;
    ignoreId?: number;
}) {
    if (!prisma) {
        console.error("[hasOverlap] prisma undefined. Revisa import de ../lib/prisma");
        return false; // evita 500 por null ref (temporal)
    }

    const { empresaId, sedeId, providerId, startAt, endAt, ignoreId } = params;
    const AND: any[] = [
        { empresaId },
        { startAt: { lt: endAt }, endAt: { gt: startAt } }, // a<y && b>x
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

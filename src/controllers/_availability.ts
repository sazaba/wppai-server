// src/controllers/_availability.ts
import prisma from "../lib/prisma";

type OverlapArgs = {
    empresaId: number;
    startAt: Date;
    endAt: Date;
    ignoreId?: number;
};

/**
 * ¿Existe una cita que solape con [startAt, endAt)?
 * Regla: (a.start < b.end) && (a.end > b.start)
 */
export async function hasOverlap(args: OverlapArgs): Promise<boolean> {
    const { empresaId, startAt, endAt, ignoreId } = args;

    const conflict = await prisma.appointment.findFirst({
        where: {
            empresaId,
            ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
            AND: [
                { startAt: { lt: endAt } }, // a.start < b.end
                { endAt: { gt: startAt } } // a.end > b.start
            ],
        },
        select: { id: true },
    });

    return Boolean(conflict);
}

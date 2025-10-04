// utils/ai/strategies/esteticaModules/booking/booking.policy.ts
import type { EsteticaCtx } from "../domain/estetica.rag";

export type BookingPolicy = {
    tz: string;
    minNoticeH: number;
    windowDays: number;
    allowSameDay: boolean;
    bufferMin: number;
    blackoutDates: string[];
};

export function buildPolicy(ctx: EsteticaCtx): BookingPolicy {
    return {
        tz: ctx.timezone || "America/Bogota",
        minNoticeH: Number(ctx.rules?.minNoticeHours ?? 0),
        windowDays: Number(ctx.rules?.bookingWindowDays ?? 30),
        allowSameDay: !!ctx.rules?.allowSameDay,
        bufferMin: Number(ctx.bufferMin ?? 10),
        blackoutDates: Array.isArray(ctx.rules?.blackoutDates)
            ? (ctx.rules!.blackoutDates as string[])
            : [],
    };
}

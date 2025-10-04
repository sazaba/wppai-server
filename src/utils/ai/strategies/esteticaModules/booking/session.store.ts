// utils/ai/strategies/esteticaModules/booking/session.store.ts
export type BookingStep =
    | "idle"
    | "await_service"
    | "await_when"
    | "await_slot"
    | "await_name_phone";

export type BookingState = {
    step: BookingStep;
    // selección
    serviceId?: number | null;
    serviceName?: string | null;
    durationMin?: number | null;

    // ventana / slot
    fromISO?: string | null;
    slots?: { idx: number; startISO: string; startLabel: string }[];
    chosenIdx?: number | null;

    // datos cliente
    fullName?: string | null;
    phone?: string | null;
};

const store = new Map<number, BookingState>();
const TTL_MS = 30 * 60 * 1000; // 30 min
const timers = new Map<number, NodeJS.Timeout>();

export function getBookingSession(convId: number): BookingState {
    return store.get(convId) ?? { step: "idle" };
}

export function setBookingSession(convId: number, state: BookingState) {
    store.set(convId, state);
    if (timers.has(convId)) clearTimeout(timers.get(convId)!);
    timers.set(
        convId,
        setTimeout(() => {
            store.delete(convId);
            timers.delete(convId);
        }, TTL_MS)
    );
}

export function clearBookingSession(convId: number) {
    store.delete(convId);
    if (timers.has(convId)) clearTimeout(timers.get(convId)!);
    timers.delete(convId);
}

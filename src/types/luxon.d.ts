// Tipado mínimo de Luxon que usamos en el proyecto.
// Evita TS7016 y mantiene autocompletado razonable.

declare module "luxon" {
    export class DateTime {
        static now(): DateTime;
        static fromJSDate(date: Date): DateTime;
        set(values: Partial<{ hour: number; minute: number; second: number; millisecond: number }>): DateTime;
        setZone(zone: string, opts?: { keepLocalTime?: boolean }): DateTime;
        startOf(unit: "day" | "week" | "month" | "year"): DateTime;
        plus(values: Partial<{ minutes: number; days: number }>): DateTime;
        minus(values: Partial<{ minutes: number; days: number }>): DateTime;
        toJSDate(): Date;
        toFormat(fmt: string): string;
        toISO(): string | null;
        setLocale(locale: string): DateTime;
        readonly weekday: number;     // Mon=1..Sun=7
        readonly isValid: boolean;
    }

    export class Interval {
        static fromDateTimes(start: DateTime, end: DateTime): Interval;
        readonly start: DateTime;
        readonly end: DateTime;
        contains(dt: DateTime): boolean;
        overlaps(other: Interval): boolean;
    }
}

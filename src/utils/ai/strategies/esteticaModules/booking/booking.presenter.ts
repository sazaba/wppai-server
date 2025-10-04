// utils/ai/strategies/esteticaModules/booking/booking.presenter.ts
type Slot = { idx: number; startISO: string; startLabel: string };

function sameYMD(a: Date, b: Date, tz: string) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(a) === fmt.format(b);
}

function isAM(d: Date, tz: string) {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d));
    return h < 12;
}

export function formatSlotsPretty(
    slots: Slot[],
    tz: string,
    header = "Estas son las próximas opciones:"
) {
    if (!slots.length) return "Por ahora no veo cupos para esa fecha/franja. ¿Reviso otro día o franja?";

    // agrupar por día
    const days: Record<string, Slot[]> = {};
    for (const s of slots) {
        const d = new Date(s.startISO);
        const key = new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d);
        (days[key] ||= []).push(s);
    }

    const lines: string[] = [header, ""];
    let globalIdx = 1;

    for (const day of Object.keys(days)) {
        const list = days[day];
        // filtrar 2 AM + 2 PM como máximo
        const am: Slot[] = [];
        const pm: Slot[] = [];
        for (const s of list) {
            const d = new Date(s.startISO);
            (isAM(d, tz) ? am : pm).push({ ...s, idx: globalIdx++ });
        }
        const am2 = am.slice(0, 2);
        const pm2 = pm.slice(0, 2);

        const dateTitle = `**${day.charAt(0).toUpperCase() + day.slice(1)}**`;
        lines.push(dateTitle);

        if (am2.length) {
            lines.push(am2.map((s, i) => `${s.idx}. ${s.startLabel.split(", ").slice(-1)[0]}`).join("\n"));
        }
        if (pm2.length) {
            if (am2.length) lines.push(""); // espacio
            lines.push(pm2.map((s, i) => `${s.idx}. ${s.startLabel.split(", ").slice(-1)[0]}`).join("\n"));
        }
        lines.push(""); // espacio entre días
    }

    lines.push("Responde con el **número** (ej. 2) o dime otra fecha/franja.");
    return lines.join("\n");
}

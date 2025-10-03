// server/src/utils/ai/strategies/esteticaModules/estetica.prompts.ts
import type { EsteticaCtx } from "./estetica.rag";

/**
 * Prompt “full-agent” para estética:
 * - Tono humano, cálido y profesional; 3–5 líneas; máx 1 emoji.
 * - SOLO usa lo que esté en el catálogo/contexto (BD/orquestador). Si falta info, dilo y ofrece opciones.
 * - Nunca inventes precios ni duraciones.
 * - En agendamiento, propone 3–6 horarios y pide confirmar con el número.
 * - Interpreta lenguaje natural con errores y coloquialismos; confirma pasos críticos.
 */
export function buildSystemPrompt(ctx: EsteticaCtx): string {
    const vertical = ctx.vertical && ctx.vertical !== "custom" ? String(ctx.vertical) : "estética";

    const addr = (ctx.logistics?.locationAddress ?? "").trim();
    const locName = (ctx.logistics?.locationName ?? "").trim();
    const mapsUrl = (ctx.logistics?.locationMapsUrl ?? "").trim();
    const arrival = (ctx.logistics?.instructionsArrival ?? "").trim();
    const parking = (ctx.logistics?.parkingInfo ?? "").trim();

    const allowSameDay = !!ctx.rules?.allowSameDay;
    const minNoticeH = ctx.rules?.minNoticeHours ?? 0;

    const depTxt = ctx.rules?.depositRequired
        ? `Puede requerirse un depósito${ctx.rules?.depositAmount ? ` (${fmtMoney(ctx.rules.depositAmount)})` : ""}.`
        : "";

    return [
        `Eres un asistente humano virtual especializado en ${vertical} para WhatsApp. Responde en 3–5 líneas, con un tono cercano y profesional (máx. 1 emoji).`,
        `Usa únicamente información del catálogo/contexto del negocio. Si falta algún dato, dilo con claridad y ofrece alternativas (pedir detalles o agendar valoración).`,
        `Nunca inventes precios ni duraciones: utiliza exactamente los valores provistos por el sistema.`,
        `Agenda (TZ ${ctx.timezone}): citas del mismo día ${allowSameDay ? "permitidas" : "NO permitidas"}; antelación mínima ${minNoticeH}h. Propón entre 3 y 6 horarios válidos y pide confirmar con el número de opción.`,
        `Interpreta lenguaje natural, acepta confirmaciones coloquiales y confirma pasos críticos de forma breve (servicio + hora + nombre + teléfono).`,
        ctx.policies ? `Políticas: ${ctx.policies}` : "",
        locName ? `Sede: ${locName}` : "",
        addr ? `Dirección: ${addr}` : "",
        mapsUrl ? `Mapa: ${mapsUrl}` : "",
        arrival ? `Indicaciones de llegada: ${arrival}` : "",
        parking ? `Parqueadero: ${parking}` : "",
        depTxt,
    ]
        .filter(Boolean)
        .join("\n");
}

/** Propuesta de horarios de agenda/reagenda */
export function fmtProposeSlots(
    slots: Date[],
    ctx: EsteticaCtx,
    verbo: "agendar" | "reagendar" = "agendar",
    preface?: string
): string {
    if (!slots || slots.length === 0) {
        return "No veo cupos libres en esa franja. ¿Busco otras fechas u horarios?";
    }
    const f = (d: Date) =>
        new Intl.DateTimeFormat("es-CO", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: ctx.timezone,
        }).format(d);

    const header = preface ?? `Puedo ${verbo} tu cita en:`;
    const list = slots
        .slice(0, 6)
        .map((s, i) => `${i + 1}. ${f(s)}`)
        .join("\n");

    return `${header}
${list}

Responde con el número de la opción o indícame otra fecha/hora.`;
}

/** Confirmación de cita (incluye código corto) */
export function fmtConfirmBooking(
    appt: { id?: number; startAt: Date; endAt: Date; serviceName?: string; customerName?: string },
    ctx: EsteticaCtx
): string {
    const f = (d: Date) =>
        new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ctx.timezone }).format(d);

    const quien = appt.customerName ? ` para ${appt.customerName}` : "";
    const servicio = appt.serviceName ? ` (${appt.serviceName})` : "";
    const loc =
        ctx.logistics?.locationName || ctx.logistics?.locationAddress
            ? `\n📍 Lugar: ${[ctx.logistics?.locationName ?? "", ctx.logistics?.locationAddress ?? ""]
                .filter(Boolean)
                .join(" — ")}`
            : "";
    const code = appt?.id ? `\n🆔 Código: APT-${String(appt.id).padStart(4, "0")}` : "";

    return `✅ Cita confirmada${quien}${servicio}
🗓️ ${f(appt.startAt)}${loc}${code}
Por favor llega 10 minutos antes.`;
}

/** COP sin decimales */
function fmtMoney(v: unknown): string {
    try {
        const n = Number(v);
        if (!Number.isFinite(n)) return "";
        return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
    } catch {
        return "";
    }
}

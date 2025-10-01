// utils/ai/strategies/esteticaModules/assistant/ai.prompts.ts
import type { EsteticaCtx } from "../estetica.rag";

/**
 * Prompt principal del agente de clínica estética
 * Genera el "cerebro" del asistente con políticas de conversación y agenda
 */
export function systemPrompt(ctx: EsteticaCtx) {
    const tz = ctx.timezone;
    const rules = ctx.rules ?? {};

    return [
        `Eres Coordinador/a de una clínica estética premium.
Tu papel es conversar de forma natural, profesional y empática,
resolviendo dudas y gestionando la agenda de servicios.

# Conocimiento
- Puedes hablar sobre estética en general (biopolímeros, toxina, lipo, skincare, postoperatorios, etc.), 
  pero no diagnostiques ni prescribas tratamientos médicos.
- Procedimientos prohibidos (ej: biopolímeros) debes desaconsejarlos y ofrecer alternativas seguras.
- Solo agendas procedimientos que están configurados en la base de datos de esta clínica.

# Herramientas
Dispones de funciones para:
- findSlots → Buscar horarios disponibles
- book → Reservar cita
- reschedule → Reagendar
- cancel / cancelMany → Cancelar citas
- listUpcomingApptsForPhone → Mostrar próximas citas de un número

# Reglas de agenda
- Zona horaria: ${tz}.
- Respeta políticas: buffer, minNotice, maxAdvance, blackoutDates, etc.
- Antes de agendar: confirma nombre completo, servicio y horario elegido.
- Muestra siempre opciones numeradas (máx. 6).
- Nunca reserves automáticamente: pide confirmación clara del usuario.

# Estilo conversacional
- Natural y cercano, como un coordinador humano.
- Respuestas cortas al inicio; usa listas claras cuando convenga.
- No repitas todo en cada mensaje, solo lo necesario.
- Ofrece la opción de hablar con un agente humano si hay dudas complejas.

# Seguridad
- No prometas resultados ni des indicaciones médicas personalizadas.
- Siempre ofrece valoración presencial como opción segura.
`
    ].join("\n");
}

/** Pide el nombre completo del paciente una sola vez antes de reservar */
export const askNameOnce =
    "Antes de reservar necesito el nombre completo para la ficha clínica. ¿A nombre de quién agendamos?";

/** Formatea una lista de slots en texto legible */
export function formatSlotList(
    dateSlots: { idx: number; startLabel: string }[],
    preface?: string
) {
    const header = preface ?? "Estas son las opciones disponibles:";
    const lines = dateSlots.map(s => `${s.idx}. ${s.startLabel}`);
    return `${header}\n${lines.join("\n")}\n\nResponde con el número (1-${dateSlots.length}) o dime otra fecha/hora.`;
}

/** Texto de confirmación antes de ejecutar el booking */
export const confirmBookingText = (name: string, service: string, whenLabel: string) =>
    `Perfecto ${name}. Reservo **${service}** para **${whenLabel}**. ¿Confirmo?`;

/** Respuesta al agendar exitosamente */
export const bookedOk = (code: string, whenLabel: string, service: string) =>
    `✅ Tu cita de **${service}** quedó confirmada para **${whenLabel}** (código ${code}). Te llegará un recordatorio automático.`;

/** Respuesta al cancelar */
export const canceledOk = (whenLabel?: string) =>
    `🗑️ He cancelado tu cita${whenLabel ? ` de ${whenLabel}` : ""}. ¿Quieres elegir otro horario?`;

/** Respuesta al reagendar */
export const rescheduledOk = (oldLabel: string, newLabel: string) =>
    `🔄 Tu cita fue reagendada: de **${oldLabel}** a **${newLabel}**.`;

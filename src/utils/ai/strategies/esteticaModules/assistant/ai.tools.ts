// Adaptadores de herramientas hacia tus funciones existentes
import type { EsteticaCtx } from '../estetica.rag'
import { findSlots, book, reschedule, cancel, listUpcomingApptsForPhone, cancelMany } from '../estetica.schedule'

type ExecEnv = {
    empresaId: number
    conversationId: number
    phone: string
    ctx: EsteticaCtx
}

export type ToolCall =
    | { tool: 'listAppointments'; args: {} }
    | { tool: 'findSlots'; args: { durationMin?: number; count?: number } }
    | { tool: 'book'; args: { serviceName: string; startAt: string; durationMin?: number; procedureId?: number; customerName?: string } }
    | { tool: 'reschedule'; args: { appointmentId: number; newStartAt: string } }
    | { tool: 'cancel'; args: { appointmentId?: number; appointmentIds?: number[] } }

export type ToolResult = { tool: string; ok: boolean; data?: any; error?: string }

export async function execTool(env: ExecEnv, call: ToolCall): Promise<ToolResult> {
    try {
        switch (call.tool) {
            case 'listAppointments': {
                const appts = await listUpcomingApptsForPhone(env.empresaId, env.phone)
                return { tool: call.tool, ok: true, data: appts }
            }
            case 'findSlots': {
                const slots = await findSlots({
                    empresaId: env.empresaId,
                    ctx: env.ctx,
                    durationMin: call.args.durationMin ?? env.ctx.rules?.defaultServiceDurationMin ?? 60,
                    count: Math.min(Math.max(call.args.count ?? 6, 3), 8),
                })
                return { tool: call.tool, ok: true, data: slots }
            }
            case 'book': {
                const appt = await book({
                    empresaId: env.empresaId,
                    conversationId: env.conversationId,
                    customerPhone: env.phone,
                    customerName: call.args.customerName,
                    serviceName: call.args.serviceName,
                    startAt: new Date(call.args.startAt),
                    durationMin: call.args.durationMin ?? env.ctx.rules?.defaultServiceDurationMin ?? 60,
                    timezone: env.ctx.timezone,
                    procedureId: call.args.procedureId,
                }, env.ctx)
                return { tool: call.tool, ok: true, data: appt }
            }
            case 'reschedule': {
                const updated = await reschedule({
                    empresaId: env.empresaId,
                    appointmentId: call.args.appointmentId,
                    newStartAt: new Date(call.args.newStartAt),
                }, env.ctx)
                return { tool: call.tool, ok: true, data: updated }
            }
            case 'cancel': {
                if (call.args.appointmentIds?.length) {
                    const many = await cancelMany({ empresaId: env.empresaId, appointmentIds: call.args.appointmentIds })
                    return { tool: call.tool, ok: true, data: many }
                }
                if (!call.args.appointmentId) throw new Error('appointmentId requerido')
                const appt = await cancel({ empresaId: env.empresaId, appointmentId: call.args.appointmentId })
                return { tool: call.tool, ok: true, data: appt }
            }
            default:
                return { tool: (call as any).tool, ok: false, error: 'tool desconocida' }
        }
    } catch (e: any) {
        return { tool: call.tool, ok: false, error: String(e?.message || e) }
    }
}

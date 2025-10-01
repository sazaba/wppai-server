import { openai } from '../../../../../lib/openai'
import prisma from '../../../../../lib/prisma'
import type { EsteticaCtx } from '../estetica.rag'
import { buildPlannerPrompt, buildFinalizerPrompt } from './ai.prompts'
import { execTool, type ToolCall, type ToolResult } from './ai.tools'

type Plan = { calls: ToolCall[]; say?: string }
function safeParsePlan(raw: string): Plan {
    try {
        const obj = JSON.parse(raw)
        const calls = Array.isArray(obj?.calls) ? obj.calls : []
        const say = typeof obj?.say === 'string' ? obj.say : ''
        return { calls, say }
    } catch { return { calls: [], say: '' } }
}

export async function runAssistantOrchestrated(input: {
    empresaId: number
    conversationId: number
    userText: string
    ctx: EsteticaCtx
}) {
    const { empresaId, conversationId, userText, ctx } = input

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { phone: true, nombre: true } })
    const phone = (conv?.phone || '').replace(/[^\d]/g, '')
    const kb = await ctx.buildKbContext()

    // 1) Planner: decide llamadas
    const planner = await openai.chat.completions.create({
        model: process.env.IA_TEXT_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' } as any,
        messages: [
            { role: 'system', content: buildPlannerPrompt(ctx, kb) },
            { role: 'user', content: `Cliente: ${conv?.nombre ?? ''} (${phone})` },
            { role: 'user', content: `Mensaje: ${userText}` },
        ],
    } as any)

    const plan = safeParsePlan(planner.choices?.[0]?.message?.content || '{}')

    // 2) Ejecutar herramientas (si las hay)
    const execResults: ToolResult[] = []
    for (const call of plan.calls) {
        const r = await execTool({ empresaId, conversationId, phone, ctx }, call as ToolCall)
        execResults.push(r)
    }

    // 3) Finalizer: redactar respuesta final con resultados
    const finalizer = await openai.chat.completions.create({
        model: process.env.IA_TEXT_MODEL || 'gpt-4o-mini',
        temperature: 0.35,
        messages: [
            { role: 'system', content: buildFinalizerPrompt(ctx) },
            { role: 'user', content: `Resultados: ${JSON.stringify(execResults)}` },
            ...(plan.say ? [{ role: 'user', content: `Borrador del planner: ${plan.say}` } as const] : []),
        ],
    } as any)

    const texto = finalizer.choices?.[0]?.message?.content?.trim() || plan.say || 'Gracias, ¿en qué más puedo ayudarte?'
    return { texto, execResults }
}

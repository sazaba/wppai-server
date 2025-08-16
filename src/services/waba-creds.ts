import prisma from '../lib/prisma'

export async function getWabaCredsByEmpresa(empresaId: number) {
    const acc = await prisma.whatsappAccount.findUnique({ where: { empresaId } })
    if (!acc?.accessToken || !acc?.wabaId) {
        throw new Error('Cuenta de WhatsApp no conectada o falta wabaId.')
    }
    return { accessToken: acc.accessToken, wabaId: acc.wabaId }
}

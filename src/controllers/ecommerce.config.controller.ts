import { Request, Response } from 'express'
import prisma from '../lib/prisma'

// GET: Obtener la configuración actual
export const getEcommerceConfig = async (req: Request, res: Response) => {
  try {
    // Asumiendo que usas un middleware que inyecta 'user' o 'empresaId' en el request
    const empresaId = (req as any).user?.empresaId

    if (!empresaId) {
      return res.status(401).json({ error: 'No autorizado o empresa no identificada' })
    }

    const config = await prisma.businessConfigEcommerce.findUnique({
      where: { empresaId: Number(empresaId) }
    })

    // Si no existe configuración, devolvemos un objeto vacío (el frontend usará los defaults)
    return res.json(config || {})
  } catch (error) {
    console.error('[getEcommerceConfig] Error:', error)
    return res.status(500).json({ error: 'Error interno al obtener configuración de tienda' })
  }
}

// POST: Guardar o Actualizar la configuración
export const updateEcommerceConfig = async (req: Request, res: Response) => {
  try {
    const empresaId = (req as any).user?.empresaId

    if (!empresaId) {
      return res.status(401).json({ error: 'No autorizado' })
    }

    const data = req.body

    // Usamos UPSERT: Si existe la actualiza, si no existe la crea.
    const config = await prisma.businessConfigEcommerce.upsert({
      where: { empresaId: Number(empresaId) },
      update: {
        isActive: data.isActive,
        storeName: data.storeName,
        currency: data.currency,
        
        // Logística
        shippingCost: data.shippingCost,
        deliveryTimeEstimate: data.deliveryTimeEstimate,
        pickupAddress: data.pickupAddress,
        
        // Pagos
        manualPaymentInfo: data.manualPaymentInfo,
        
        // IA y Cierre
        aiSellingStyle: data.aiSellingStyle,
        closingInstructions: data.closingInstructions,
        
        // Políticas
        returnPolicy: data.returnPolicy,
        warrantyPolicy: data.warrantyPolicy,
      },
      create: {
        empresaId: Number(empresaId),
        isActive: data.isActive || false,
        storeName: data.storeName,
        currency: data.currency || 'COP',
        
        shippingCost: data.shippingCost,
        deliveryTimeEstimate: data.deliveryTimeEstimate,
        pickupAddress: data.pickupAddress,
        
        manualPaymentInfo: data.manualPaymentInfo,
        
        aiSellingStyle: data.aiSellingStyle || 'asesor',
        closingInstructions: data.closingInstructions,
        
        returnPolicy: data.returnPolicy,
        warrantyPolicy: data.warrantyPolicy,
      }
    })

    return res.json(config)
  } catch (error) {
    console.error('[updateEcommerceConfig] Error:', error)
    return res.status(500).json({ error: 'Error interno al guardar configuración de tienda' })
  }
}

// DELETE: Borrar configuración de tienda
export const deleteEcommerceConfig = async (req: Request, res: Response) => {
  try {
    const empresaId = (req as any).user?.empresaId
    if (!empresaId) return res.status(401).json({ error: 'No autorizado' })

    // Borramos la configuración (Por la relación Cascade, esto debería borrar dependencias si las hubiera)
    await prisma.businessConfigEcommerce.deleteMany({
      where: { empresaId: Number(empresaId) }
    })

    return res.json({ success: true, message: 'Tienda eliminada' })
  } catch (error) {
    console.error('Error borrando tienda:', error)
    return res.status(500).json({ error: 'Error al eliminar tienda' })
  }
}
import { Request, Response } from 'express';
// Ajusta la ruta '../lib/prisma' según donde tengas instanciado tu PrismaClient
import  prisma  from '../lib/prisma'; 
import { getEmpresaId } from './_getEmpresaId';

export const saveClient = async (req: Request, res: Response) => {
  try {
    const empresaId = getEmpresaId(req);
    const { name, phone, procedure, notes } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ ok: false, message: 'Faltan datos obligatorios (nombre, teléfono)' });
    }

    // Usamos UPSERT:
    // - Si el teléfono ya existe en esta empresa -> Actualiza nombre y último proc.
    // - Si no existe -> Lo crea.
    const client = await prisma.client.upsert({
      where: {
        empresaId_phone: {
          empresaId,
          phone,
        },
      },
      update: {
        name, // Actualizamos el nombre por si corrigieron un error tipográfico
        lastProcedure: procedure,
        lastProcedureDate: new Date(),
        // Solo actualizamos notas si vienen nuevas, para no borrar historial previo si envían vacío
        ...(notes ? { notes } : {}),
      },
      create: {
        empresaId,
        name,
        phone,
        lastProcedure: procedure,
        lastProcedureDate: new Date(),
        notes,
      },
    });

    return res.status(200).json({ ok: true, data: client });
  } catch (error: any) {
    console.error('Error en saveClient:', error);
    return res.status(500).json({ ok: false, message: 'Error interno al guardar cliente' });
  }
};

export const getClients = async (req: Request, res: Response) => {
  try {
    const empresaId = getEmpresaId(req);
    
    // Obtenemos clientes ordenados por la fecha de su último procedimiento (más recientes primero)
    const clients = await prisma.client.findMany({
      where: { empresaId },
      orderBy: { lastProcedureDate: 'desc' },
      take: 200, // Límite de seguridad
    });

    return res.json({ ok: true, data: clients });
  } catch (error: any) {
    console.error('Error en getClients:', error);
    return res.status(500).json({ ok: false, message: 'Error al obtener clientes' });
  }
};
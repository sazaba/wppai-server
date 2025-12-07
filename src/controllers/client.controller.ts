import { Request, Response } from 'express';
// Ajusta la ruta a tu instancia de prisma
import prisma from '../lib/prisma'; 
import { getEmpresaId } from './_getEmpresaId'; // Tu helper actual

// --- GUARDAR O ACTUALIZAR (UPSERT) ---
export const saveClient = async (req: Request, res: Response) => {
  try {
    const empresaId = getEmpresaId(req);
    const { name, phone, procedure, notes, date } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ ok: false, message: 'Faltan datos obligatorios (nombre, teléfono)' });
    }

    // Parseamos la fecha si viene manual, si no, usamos la actual
    const procDate = date ? new Date(date) : new Date();

    const client = await prisma.client.upsert({
      where: {
        empresaId_phone: {
          empresaId,
          phone,
        },
      },
      update: {
        name,
        lastProcedure: procedure,
        lastProcedureDate: procDate,
        // Si lo guardan de nuevo, nos aseguramos que esté activo (por si estaba en papelera)
        status: 'active', 
        // Solo actualizamos notas si vienen datos
        ...(notes ? { notes } : {}),
      },
      create: {
        empresaId,
        name,
        phone,
        lastProcedure: procedure,
        lastProcedureDate: procDate,
        notes,
        status: 'active',
      },
    });

    return res.status(200).json({ ok: true, data: client });
  } catch (error: any) {
    console.error('Error en saveClient:', error);
    return res.status(500).json({ ok: false, message: 'Error interno al guardar cliente' });
  }
};

// --- LISTAR CLIENTES ---
export const getClients = async (req: Request, res: Response) => {
  try {
    const empresaId = getEmpresaId(req);
    
    const clients = await prisma.client.findMany({
      where: { empresaId },
      orderBy: { lastProcedureDate: 'desc' },
      take: 500, // Límite seguro
    });

    return res.json({ ok: true, data: clients });
  } catch (error: any) {
    console.error('Error en getClients:', error);
    return res.status(500).json({ ok: false, message: 'Error al obtener clientes' });
  }
};

// --- CAMBIAR ESTADO (PAPELERA / RESTAURAR) ---
export const updateClientStatus = async (req: Request, res: Response) => {
  try {
    const empresaId = getEmpresaId(req);
    const { id } = req.params;
    const { status } = req.body; // Esperamos 'active' o 'trash'

    if (!id || !status) {
      return res.status(400).json({ ok: false, message: 'Faltan datos (ID o status)' });
    }

    const client = await prisma.client.updateMany({
      where: { 
        id: Number(id),
        empresaId // Seguridad: asegurar que pertenece a la empresa
      },
      data: { status }
    });

    if (client.count === 0) {
      return res.status(404).json({ ok: false, message: 'Cliente no encontrado' });
    }

    return res.json({ ok: true, message: 'Estado actualizado' });
  } catch (error) {
    console.error('Error updating client status:', error);
    return res.status(500).json({ ok: false, message: 'Error al actualizar estado' });
  }
};
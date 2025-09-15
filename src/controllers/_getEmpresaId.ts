// src/controllers/_getEmpresaId.ts
import { Request } from "express";

export function getEmpresaId(req: Request): number {
    const fromUser = (req as any).user?.empresaId;          // viene de verificarJWT
    const fromQuery = req.query.empresaId
        ? Number(req.query.empresaId)
        : undefined;

    const empresaId = fromUser ?? fromQuery;
    if (!empresaId || Number.isNaN(empresaId)) {
        // lanzar un 400 como error controlado
        const err = new Error("empresaId es requerido (JWT o ?empresaId=)");
        (err as any).status = 400;
        throw err;
    }
    return empresaId;
}

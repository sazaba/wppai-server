"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEmpresaId = getEmpresaId;
function getEmpresaId(req) {
    const fromUser = req.user?.empresaId; // viene de verificarJWT
    const fromQuery = req.query.empresaId
        ? Number(req.query.empresaId)
        : undefined;
    const empresaId = fromUser ?? fromQuery;
    if (!empresaId || Number.isNaN(empresaId)) {
        // lanzar un 400 como error controlado
        const err = new Error("empresaId es requerido (JWT o ?empresaId=)");
        err.status = 400;
        throw err;
    }
    return empresaId;
}

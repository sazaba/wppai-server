// src/middleware/cron.middleware.ts
import { Request, Response, NextFunction } from "express";

export const verifyCronToken = (req: Request, res: Response, next: NextFunction) => {
    // 1) Intentar leer Authorization: Bearer xxx
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice("Bearer ".length);
    }

    // 2) Si no viene Authorization, intentar x-cron-auth (modo viejo)
    if (!token && typeof req.headers["x-cron-auth"] === "string") {
        token = req.headers["x-cron-auth"] as string;
    }

    // 3) Validar contra la env
    const expected = process.env.CRON_INTERNAL_TOKEN;
    if (!token || !expected || token !== expected) {
        return res.status(401).json({ error: "CRON token inválido" });
    }

    return next();
};

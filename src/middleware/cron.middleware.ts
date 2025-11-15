// src/middleware/cron.middleware.ts
import { Request, Response, NextFunction } from "express";

export const verifyCronToken = (req: Request, res: Response, next: NextFunction) => {
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice("Bearer ".length);
    }

    if (!token && typeof req.headers["x-cron-auth"] === "string") {
        token = req.headers["x-cron-auth"] as string;
    }

    const expected = process.env.CRON_INTERNAL_TOKEN;

    if (!token || !expected || token !== expected) {
        console.error("[verifyCronToken] Token inválido", {
            hasAuthHeader: !!authHeader,
            hasXHeader: !!req.headers["x-cron-auth"],
        });
        return res.status(401).json({ error: "CRON token inválido" });
    }

    return next();
};

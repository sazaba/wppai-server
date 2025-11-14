import { Request, Response, NextFunction } from "express";

export const verifyCronToken = (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers["x-cron-auth"];

    if (!key || key !== process.env.CRON_INTERNAL_TOKEN) {
        return res.status(401).json({ error: "CRON token inválido" });
    }

    return next();
};

// utils/ai/strategies/esteticaModules/log.ts
type LogLevel = "debug" | "info" | "warn" | "error";

function ts() { return new Date().toISOString(); }

export const Logger = {
    child(ns: string) {
        const tag = `[${ns}]`;
        return {
            debug: (msg: string, extra?: unknown) => console.debug(ts(), tag, msg, extra ?? ""),
            info: (msg: string, extra?: unknown) => console.info(ts(), tag, msg, extra ?? ""),
            warn: (msg: string, extra?: unknown) => console.warn(ts(), tag, msg, extra ?? ""),
            error: (msg: string, extra?: unknown) => console.error(ts(), tag, msg, extra ?? ""),
        };
    },
};

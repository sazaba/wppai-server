// server/src/utils/logger.ts
export const DBG = (ns: string) => {
    const on = process.env.ESTETICA_DEBUG === "1";
    const pfx = `[${ns}]`;
    return {
        info: (...a: any[]) => on && console.log(pfx, ...a),
        warn: (...a: any[]) => on && console.warn(pfx, ...a),
        error: (...a: any[]) => on && console.error(pfx, ...a),
    };
};

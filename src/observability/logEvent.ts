import type {LoggerService} from "@nestjs/common";
import {INSTANCE_ID} from "./instance.js";

// The allow-list is the security control (README §12): ids and codes only. A field that is not here does not compile,
// so an amount, a balance or a request body cannot be logged by accident. Error *messages* are left out on purpose:
// driver errors can quote values; the error class name is enough to diagnose.
export interface LogFields {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
    status?: string;
    failureCode?: string;
    source?: string;
    errorType?: string;
    httpStatus?: number;
    method?: string;
    path?: string;
    port?: number;
}

// One JSON object per event when the app runs with ConsoleLogger({ json: true }) (main.ts). `instanceId` is added here,
// not by the caller, so no line can forget it.
export function logEvent(logger: LoggerService, name: string, fields: LogFields, level: 'log' | 'warn' | 'error' = 'log', stack?: string): void {
    const line = {event: name, instanceId: INSTANCE_ID, ...fields};
    if (stack) logger[level](line, stack);
    else logger[level](line);
}

export const errorType = (error: unknown) => error instanceof Error ? error.name : 'NonError';

import {ArgumentsHost, Catch, ExceptionFilter, Logger} from "@nestjs/common";
import type {Request, Response} from "express";
import {toHttp} from "./toHttp.js";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(DomainExceptionFilter.name);

    catch(error: unknown, host: ArgumentsHost) {
        const http = host.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();
        const {status, code, message, retryable, headers, details} = toHttp(error);

        const correlationId = req.header('x-correlation-id');
        const line = `${req.method} ${req.url} -> ${status} ${code} correlationId=${correlationId ?? '-'}`;
        if (status >= 500) this.logger.error(line, error instanceof Error ? error.stack : String(error));
        else this.logger.warn(line);

        for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
        res.status(status).json({status, code, message, retryable, ...(details === undefined ? {} : {details})});
    }
}

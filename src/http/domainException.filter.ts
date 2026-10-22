import {ArgumentsHost, Catch, ExceptionFilter, Logger} from "@nestjs/common";
import type {Request, Response} from "express";
import {toHttp} from "./toHttp.js";
import {logEvent} from "../observability/logEvent.js";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(DomainExceptionFilter.name);

    catch(error: unknown, host: ArgumentsHost) {
        const http = host.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();
        const {status, code, message, retryable, headers, details} = toHttp(error);

        // the controller sets the header on the response when the caller sent none
        const correlationId = req.header('x-correlation-id') ?? res.getHeader('x-correlation-id')?.toString();
        const fields = {correlationId, method: req.method, path: req.path, httpStatus: status, failureCode: code};
        if (status >= 500) logEvent(this.logger, 'http.error', fields, 'error', error instanceof Error ? error.stack : String(error));
        else logEvent(this.logger, 'http.error', fields, 'warn');

        for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
        res.status(status).json({status, code, message, retryable, ...(details === undefined ? {} : {details})});
    }
}

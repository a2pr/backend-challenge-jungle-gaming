import {Body, Controller, Headers, Post, Res, UseGuards} from '@nestjs/common';
import type {Response} from 'express';
import {randomUUID} from "node:crypto";
import {AuthGuard} from "../http/auth.guard.js";
import {BadRequestError} from "../http/errors.js";
import {parse} from "../http/zodValidation.js";
import {submitTransactionSchema, toCommand} from "../http/dto/submitTransaction.dto.js";
import {toResponse, TransactionBody} from "../http/transactionResponse.js";
import {SubmitWagerTransactionUseCase} from "./SubmitWagerTransaction.usecase.js";

@Controller('wagering')
@UseGuards(AuthGuard)
export class WageringController {
    constructor(private readonly submitWager: SubmitWagerTransactionUseCase) {}

    @Post('transactions')
    async submit(
        @Body() body: unknown,
        @Headers('idempotency-key') key: string | undefined,           // Express lowercases header names
        @Headers('x-correlation-id') correlationHeader: string | undefined,
        @Res({passthrough: true}) res: Response,                       // passthrough: Nest still sends our return value
    ): Promise<TransactionBody> {
        if (!key || key.length > 255) throw new BadRequestError('Idempotency-Key header is required (1 to 255 characters)');
        const dto = parse(submitTransactionSchema, body);
        const correlationId = correlationHeader || randomUUID();
        res.setHeader('x-correlation-id', correlationId);

        const outcome = await this.submitWager.execute(toCommand(dto, key), {correlationId});
        if (outcome.kind !== 'completed') throw new Error('unreachable: duplicate-message needs an inbox context');

        const {status, body: responseBody} = toResponse(outcome);
        res.status(status);
        return responseBody;
    }
}

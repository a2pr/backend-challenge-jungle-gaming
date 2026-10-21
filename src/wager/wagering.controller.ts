import {Body, Controller, Get, Headers, Param, Post, Res, UseGuards} from '@nestjs/common';
import {MikroORM} from "@mikro-orm/postgresql";
import type {Response} from 'express';
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {AuthGuard} from "../http/auth.guard.js";
import {BadRequestError} from "../http/errors.js";
import {parse} from "../http/zodValidation.js";
import {submitTransactionSchema, toCommand} from "../http/dto/submitTransaction.dto.js";
import {toResponse, toStoredBody, TransactionBody} from "../http/transactionResponse.js";
import {SubmitWagerTransactionUseCase} from "./SubmitWagerTransaction.usecase.js";
import {TransactionNotFoundError} from "./errors.js";
import {WagerTransactionRepository} from "./wagerTransaction.repository.js";

// No class prefix: the provider lookup lives under /providers, so each route spells its full path.
@Controller()
@UseGuards(AuthGuard)
export class WageringController {
    constructor(
        private readonly orm: MikroORM,
        private readonly submitWager: SubmitWagerTransactionUseCase,
        private readonly transactions: WagerTransactionRepository,
    ) {
    }

    @Post('wagering/transactions')
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

    // Reads: always 200 for a stored row, whatever its status (D9); 404 when there is none.
    @Get('wagering/transactions/:transactionId')
    async getById(@Param('transactionId') rawId: string): Promise<TransactionBody> {
        const id = parse(z.uuid(), rawId);                // a non-UUID is a 400, not a Postgres error (503)
        const stored = await this.transactions.findById(this.orm.em.fork(), id);
        if (!stored) throw new TransactionNotFoundError(id);
        return toStoredBody(stored);
    }

    // The provider is part of the lookup: the same external id under another provider is another transaction.
    @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
    async getByExternalId(
        @Param('providerId') providerId: string,
        @Param('externalTransactionId') externalId: string,
    ): Promise<TransactionBody> {
        const stored = await this.transactions.findByExternalId(this.orm.em.fork(), providerId, externalId);
        if (!stored) throw new TransactionNotFoundError(`${providerId}/${externalId}`);
        return toStoredBody(stored);
    }
}

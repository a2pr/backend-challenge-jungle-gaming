import {Body, Controller, Get, HttpCode, Logger, Param, Post, Query, UseGuards} from '@nestjs/common';
import {MikroORM} from "@mikro-orm/postgresql";
import {z} from "zod";
import {parse} from "../http/zodValidation.js";
import {createWalletSchema} from "../http/dto/createWallet.dto.js";
import {decodeCursor, encodeCursor} from "../http/cursor.js";
import {AuthGuard} from "../http/auth.guard.js";
import {CreateWalletUseCase} from "./createWallet.usecase.js";
import {WalletRepository} from "./wallet.repository.js";
import {WalletLedgerRepository} from "./walletLedger.repository.js";
import {WalletNotFoundError} from "../wager/errors.js";
import {MetricsService} from "../observability/metrics.service.js";
import {logEvent} from "../observability/logEvent.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ledgerQuery = z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).default(DEFAULT_LIMIT),
});

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletController {
    private readonly logger = new Logger(WalletController.name);

    constructor(
        private readonly orm: MikroORM,
        private readonly createWallet: CreateWalletUseCase,
        private readonly wallets: WalletRepository,
        private readonly ledger: WalletLedgerRepository,
        private readonly metrics: MetricsService,
    ) {
    }

    // 201 is Nest's default for @Post; the use case result already has the README body.
    @Post()
    create(@Body() body: unknown) {
        return this.createWallet.execute(parse(createWalletSchema, body))
    }

    @Get(':id')
    async findOne(@Param('id') rawId: string) {
        const id = parse(z.uuid(), rawId)      // a non-UUID is a 400, not a Postgres error (503)
        const wallet = await this.wallets.findById(this.orm.em.fork(), id)
        if (!wallet) throw new WalletNotFoundError(id)
        return {id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version}
    }

    @Get(':id/ledger')
    async page(@Param('id') rawId: string, @Query() rawQuery: unknown) {
        const id = parse(z.uuid(), rawId)
        const query = parse(ledgerQuery, rawQuery)
        const limit = Math.min(query.limit, MAX_LIMIT)
        const afterSeq = query.cursor === undefined ? 0 : decodeCursor(query.cursor)

        const em = this.orm.em.fork()
        if (!await this.wallets.findById(em, id)) throw new WalletNotFoundError(id)

        const rows = await this.ledger.page(em, id, afterSeq, limit + 1)   // the extra row says whether another page exists
        const hasMore = rows.length > limit
        const items = rows.slice(0, limit)
        return {
            items: items.map(({seq: _seq, createdAt, ...item}) => ({...item, createdAt: createdAt.toISOString()})),
            nextCursor: hasMore ? encodeCursor(items[items.length - 1].seq) : null,
        }
    }

    // Reports a difference, never repairs it: no write to the wallet, no compensating ledger entry.
    @Post(':id/reconciliation')
    @HttpCode(200)
    async reconcile(@Param('id') rawId: string) {
        const id = parse(z.uuid(), rawId)
        const r = await this.ledger.reconcile(this.orm.em.fork(), id)
        if (!r) throw new WalletNotFoundError(id)

        const consistent = r.difference === '0.00'
        if (!consistent) {
            // ids only: the stored and calculated balances are in the response body, not in the logs
            this.metrics.reconciliationMismatch.inc()
            logEvent(this.logger, 'reconciliation.mismatch', {walletId: id}, 'error')
        }
        const money = (amount: string) => ({amount, currency: r.currency})
        return {
            walletId: id,
            storedBalance: money(r.storedBalance),
            calculatedBalance: money(r.ledgerBalance),
            difference: money(r.difference),
            consistent,
            checkedEntries: r.entries,
        }
    }
}

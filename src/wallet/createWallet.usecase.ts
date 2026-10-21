import MoneyProps from "../money/dto/money.props.dto.js";
import {randomUUID} from "node:crypto";
import Wallet from "./wallet.js";
import {MikroORM} from "@mikro-orm/postgresql";
import {WalletRepository} from "./wallet.repository.js";
import {WagerTransactionRepository} from "../wager/wagerTransaction.repository.js";
import {WalletLedgerRepository} from "./walletLedger.repository.js";
import {OutboxRepository} from "../messaging/outbox.repository.js";
import {EntityManager, UniqueConstraintViolationException} from "@mikro-orm/core";
import {Injectable} from "@nestjs/common";
import WagerTransaction from "../wager/wagerTransaction.js";
import WalletLedgerEntry from "./walletLedgerEntry.js";
import {IntegrationEvent} from "../events/integrationEvent.js";
import {WalletBalanceChanged} from "../events/walletBalanceChanged.js";
import {WagerTransactionProcessed} from "../events/wagerTransactionProcessed.js";
import {WagerTransactionKind} from "../wager/wagerTransactionKind.js";
import {DuplicateWalletError} from "./errors.js";
import Money from "../money/money.js";

export interface CreateWalletCommand {
    playerId: string;
    initialBalance: MoneyProps;
}

export interface CreateWalletResult {
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
}

// Values shared by every row and event of one call, created once in execute.
interface CreateInput {
    walletId: string;
    openingId: string;
    playerId: string;
    initialBalance: Money;
    correlationId: string;
    now: Date;
}

@Injectable()
export class CreateWalletUseCase {
    constructor(
        private readonly orm: MikroORM,
        private readonly walletRepo: WalletRepository,
        private readonly wagerTransactionRepo: WagerTransactionRepository,
        private readonly walletLedgerRepo: WalletLedgerRepository,
        private readonly outboxRepo: OutboxRepository,
    ) {
    }

    async execute(command: CreateWalletCommand, ctx?: { correlationId?: string }): Promise<CreateWalletResult> {
        const initialBalance = Money.from(command.initialBalance)
        const now = new Date()
        const walletId = randomUUID()
        const openingId = randomUUID()
        const correlationId = ctx?.correlationId ?? randomUUID()
        const em = this.orm.em.fork()

        let wallet: Wallet
        try {
            wallet = await em.transactional((tx) => this.createInTransaction(tx, {
                walletId, openingId, playerId: command.playerId, initialBalance, correlationId, now,
            }))
        } catch (error) {
            // Translated after the rollback: a failed statement aborts the Postgres transaction.
            if (error instanceof UniqueConstraintViolationException) {
                throw new DuplicateWalletError(command.playerId, initialBalance.currency)
            }
            throw error
        }

        return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: wallet.balance.toJSON(),
            version: wallet.version
        }
    }

    private async createInTransaction(tx: EntityManager, input: CreateInput): Promise<Wallet> {
        const {walletId, openingId, playerId, initialBalance, correlationId, now} = input
        const wallet = Wallet.open({id: walletId, playerId, initialBalance, now})
        await this.walletRepo.insert(tx, wallet)

        const entry = wallet.openingEntry({entryId: randomUUID(), transactionId: openingId, now})
        if (!entry) return wallet // zero balance: nothing to record

        // The ledger row references the transaction row, so the transaction goes first.
        const opening = this.buildOpeningTransaction(wallet, openingId, now)
        await this.wagerTransactionRepo.insert(tx, opening, {balanceAfter: wallet.balance.toString()})
        await this.walletLedgerRepo.insert(tx, entry)
        await this.outboxRepo.enqueue(tx, this.buildEvents(wallet, entry, opening, correlationId, now))
        return wallet
    }

    // Conventions: ARCHITECTURE.md schema note (d).
    private buildOpeningTransaction(wallet: Wallet, openingId: string, now: Date): WagerTransaction {
        const opening = WagerTransaction.create({
            id: openingId,
            providerId: 'internal',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: wallet.balance,
            now,
        })
        opening.markProcessed(undefined, now)
        return opening
    }

    private buildEvents(wallet: Wallet, entry: WalletLedgerEntry, opening: WagerTransaction, correlationId: string, now: Date): IntegrationEvent<unknown>[] {
        const ctx = () => ({eventId: randomUUID(), correlationId, occurredAt: now})
        return [
            WalletBalanceChanged.from(wallet, entry, ctx()),
            WagerTransactionProcessed.from(opening, wallet.balance, ctx()),
        ]
    }
}

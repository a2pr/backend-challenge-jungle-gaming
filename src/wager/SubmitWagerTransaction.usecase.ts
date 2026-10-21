import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";
import {FailureCode} from "./failureCode.js";
import MoneyProps from "../money/dto/money.props.dto.js";
import {Injectable} from "@nestjs/common";
import {MikroORM} from "@mikro-orm/postgresql";
import {WalletRepository} from "../wallet/wallet.repository.js";
import {WagerTransactionRepository} from "./wagerTrasanction.repository.js";
import {WalletLedgerRepository} from "../wallet/walletLedger.repository.js";
import {OutboxRepository} from "../messaging/outbox.repository.js";
import {InboxRepository} from "../messaging/inbox.repository.js";
import {EntityManager} from "@mikro-orm/core";
import WagerTransaction from "./wagerTransaction.js";
import Wallet from "../wallet/wallet.js";
import WalletLedgerEntry, {LedgerDirection} from "../wallet/walletLedgerEntry.js";
import {IntegrationEvent} from "../events/integrationEvent.js";
import {randomUUID} from "node:crypto";
import {InsufficientFundsError} from "../wallet/errors.js";
import {WalletNotFoundError} from "./errors.js";
import {WalletBalanceChanged} from "../events/walletBalanceChanged.js";
import {WagerTransactionProcessed} from "../events/wagerTransactionProcessed.js";
import {WagerTransactionRejected} from "../events/wagerTransactionRejected.js";
import {WagerTransactionPendingReference} from "../events/wagerTransactionPendingReference.js";

export interface SubmitWagerCommand {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
}

export interface SubmitWagerContext {
    correlationId?: string;
    causationId?: string
}

export interface WagerResult {
    kind: 'completed';
    transactionId: string;
    status: WagerTransactionStatus;
    failureCode?: FailureCode;
    balance: MoneyProps;
    idempotentReplay: boolean
}

// Values shared by every row and event of one call, created once in execute.
interface RunInput {
    command: SubmitWagerCommand;
    transactionId: string;
    correlationId: string;
    causationId: string | undefined;
    now: Date;
}

// A request stuck behind a hot wallet fails instead of queueing forever (D1).
const LOCK_TIMEOUT = '5s'

@Injectable()
export class SubmitWagerTransactionUseCase {
    constructor(
        private readonly orm: MikroORM,
        private readonly walletRepo: WalletRepository,
        private readonly wagerTransactionRepo: WagerTransactionRepository,
        private readonly walletLedgerRepo: WalletLedgerRepository,
        private readonly outboxRepo: OutboxRepository,
        private readonly inboxRepo: InboxRepository
    ) {
    }

    async execute(command: SubmitWagerCommand, ctx?: SubmitWagerContext): Promise<WagerResult> {
        let now = new Date()
        let transactionId = randomUUID()
        let correlationId = ctx?.correlationId ?? randomUUID()
        const em = this.orm.em.fork()

        return em.transactional((tx) => this.run(tx, {
            command,
            transactionId,
            correlationId,
            causationId: ctx?.causationId,
            now
        }))
    }

    private async run(tx: EntityManager, input: RunInput): Promise<WagerResult> {
        const {command, transactionId, correlationId, causationId, now} = input
        // Raw SQL: pass the transaction context or it runs on another connection.
        await tx.getConnection().execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, [], 'run', tx.getTransactionContext())

        // First statement on the data: serialises everything for this wallet.
        const wallet = await this.walletRepo.lockById(tx, command.walletId)
        if (!wallet) throw new WalletNotFoundError(command.walletId)

        // A bad request throws here, before any write.
        const wager = this.buildTransaction(command, transactionId, now)

        let entry: WalletLedgerEntry | undefined
        const walletFailure = this.checkWallet(wallet, wager)
        if (walletFailure) wager.reject(walletFailure)
        else entry = this.apply(wallet, wager, undefined, now)

        const events = this.buildEvents(wallet, wager, entry, correlationId, causationId, now)
        await this.persist(tx, wallet, wager, entry, events)
        return this.toResult(wager, wallet.balance, false)
    }

    private buildTransaction(command: SubmitWagerCommand, id: string, now: Date): WagerTransaction {
        return WagerTransaction.create({id, ...command, now})
    }

    private checkWallet(wallet: Wallet, wager: WagerTransaction): FailureCode | null {
        if (wager.playerId !== wallet.playerId) return FailureCode.PlayerMismatch
        if (wager.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch

        return null
    }

    private apply(wallet: Wallet, wager: WagerTransaction, reference: WagerTransaction | undefined, now: Date): WalletLedgerEntry | undefined {
        if (!wager.affectsBalance()) {
            wager.markProcessed(reference?.id, now)
            return undefined
        }
        let entry: WalletLedgerEntry
        try {
            const direction = wager.ledgerDirectionFor(reference)
            const movement = {entryId: randomUUID(), transactionId: wager.id, now}
            entry = direction === LedgerDirection.Credit
                ? wallet.credit(wager.money, movement)
                : wallet.debit(wager.money, movement)
        } catch (error) {
            if (error instanceof InsufficientFundsError) {
                // debit validates before it mutates, so the wallet is untouched
                wager.reject(wager.kind === WagerTransactionKind.Rollback ? FailureCode.InsufficientFundsForReversal : FailureCode.InsufficientFunds)
                return undefined
            }
            throw error
        }

        wager.markProcessed(reference?.id, now)
        return entry
    }

    private buildEvents(wallet: Wallet, wager: WagerTransaction, entry: WalletLedgerEntry | undefined, correlationId: string, causationId: string | undefined, now: Date): IntegrationEvent<unknown>[] {
        // one context per event: each needs its own eventId
        const ctx = () => ({eventId: randomUUID(), correlationId, causationId, occurredAt: now})
        switch (wager.status) {
            case WagerTransactionStatus.Processed:
                return entry
                    ? [WalletBalanceChanged.from(wallet, entry, ctx()), WagerTransactionProcessed.from(wager, wallet.balance, ctx())]
                    : [WagerTransactionProcessed.from(wager, wallet.balance, ctx())]
            case WagerTransactionStatus.Rejected:
                return [WagerTransactionRejected.from(wager, wallet.balance, ctx())]
            case WagerTransactionStatus.PendingReference:
                return [WagerTransactionPendingReference.from(wager, ctx())]
            default:
                throw new Error(`no events for status ${wager.status}`) // caller bug
        }
    }

    private async persist(tx: EntityManager, wallet: Wallet, wager: WagerTransaction, entry: WalletLedgerEntry | undefined, events: IntegrationEvent<unknown>[]): Promise<void> {
        if (entry) await this.walletRepo.save(tx, wallet)
        // The ledger row references the transaction row, so the transaction goes first.
        await this.wagerTransactionRepo.insert(tx, wager, {balanceAfter: wallet.balance.toString()})
        if (entry) await this.walletLedgerRepo.insert(tx, entry)
        await this.outboxRepo.enqueue(tx, events)
    }

    private toResult(wager: WagerTransaction, balanceAfter: Money, replay: boolean): WagerResult {
        return {
            kind: 'completed',
            transactionId: wager.id,
            status: wager.status,
            failureCode: wager.failureCode,
            balance: balanceAfter.toJSON(),
            idempotentReplay: replay,
        }
    }
}

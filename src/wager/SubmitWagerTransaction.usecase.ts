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
import {DuplicateExternalTransactionError, IdempotencyConflictError, WalletNotFoundError} from "./errors.js";
import {WalletBalanceChanged} from "../events/walletBalanceChanged.js";
import {WagerTransactionProcessed} from "../events/wagerTransactionProcessed.js";
import {WagerTransactionRejected} from "../events/wagerTransactionRejected.js";
import {WagerTransactionPendingReference} from "../events/wagerTransactionPendingReference.js";

type ReferenceOutcome =
    | { kind: 'none' }                                 // the transaction has no reference
    | { kind: 'pending' }                              // the reference is unknown or not final yet
    | { kind: 'rejected'; code: FailureCode }
    | { kind: 'found'; reference: WagerTransaction };  // PROCESSED and consistent

export type SubmitWagerOutcome = WagerResult | { kind: 'duplicate-message' }

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
    inbox?: { consumerName: string; messageId: string; payloadHash: string }
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
    inbox: SubmitWagerContext['inbox'];
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

    async execute(command: SubmitWagerCommand, ctx?: SubmitWagerContext): Promise<SubmitWagerOutcome> {
        let now = new Date()
        let transactionId = randomUUID()
        let correlationId = ctx?.correlationId ?? randomUUID()
        const em = this.orm.em.fork()

        return em.transactional((tx) => this.run(tx, {
            command,
            transactionId,
            correlationId,
            causationId: ctx?.causationId,
            inbox: ctx?.inbox,
            now
        }))
    }

    private async run(tx: EntityManager, input: RunInput): Promise<SubmitWagerOutcome> {
        const inbox = input.inbox
        if (inbox && !(await this.inboxRepo.tryInsert(tx, {...inbox, receivedAt: input.now}))) {
            return {kind: 'duplicate-message'}        // already committed by an earlier delivery: the consumer acks it
        }
        const result = await this.process(tx, input)
        if (inbox) await this.inboxRepo.markProcessed(tx, inbox.consumerName, inbox.messageId, input.now)
        return result
    }

    private async process(tx: EntityManager, input: RunInput): Promise<SubmitWagerOutcome> {
        const {command, transactionId, correlationId, causationId, now} = input
        // Raw SQL: pass the transaction context or it runs on another connection.
        await tx.getConnection().execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, [], 'run', tx.getTransactionContext())

        // First statement on the data: serialises everything for this wallet.
        const wallet = await this.walletRepo.lockById(tx, command.walletId)
        if (!wallet) throw new WalletNotFoundError(command.walletId)

        // A bad request throws here, before any write.
        const wager = this.buildTransaction(command, transactionId, now)

        // step 5
        const byKey = await this.wagerTransactionRepo.findByIdempotencyKey(tx, wager.providerId, wager.idempotencyKey)
        if (byKey) {
            if (!byKey.transaction.matchesPayload(wager.payloadHash)) {
                throw new IdempotencyConflictError(wager.providerId, wager.idempotencyKey)
            }
            // every insert writes balanceAfter, so null is a bug, not a request error
            if (byKey.balanceAfter === null) throw new Error(`Transaction ${byKey.transaction.id} has no balanceAfter`)
            return this.toResult(byKey.transaction, Money.from({
                amount: byKey.balanceAfter,
                currency: byKey.transaction.money.currency
            }), true)
        }
        const byExternal = await this.wagerTransactionRepo.findByExternalId(
            tx,
            wager.providerId,
            wager.externalTransactionId
        )
        if (byExternal) {
            throw new DuplicateExternalTransactionError(wager.providerId, wager.externalTransactionId)
        }


        let entry: WalletLedgerEntry | undefined
        const walletFailure = this.checkWallet(wallet, wager)
        if (walletFailure) {
            wager.reject(walletFailure)
        } else {
            const ref = await this.resolveReference(tx, wager)
            if (ref.kind === 'rejected') wager.reject(ref.code)
            else if (ref.kind === 'pending') wager.markPendingReference(now)
            else entry = this.apply(wallet, wager, ref.kind === 'found' ? ref.reference : undefined, now)
        }

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


    // Reads only. Order of the answers the provider can see: unknown or not final (pending) -> REJECTED/FAILED reference
    // -> checkReference (provider, player, wallet, currency, round, kind, amount) -> already reversed -> found.
    private async resolveReference(tx: EntityManager, wager: WagerTransaction): Promise<ReferenceOutcome> {
        if (!wager.requiresReference() && !wager.hasReference()) return {kind: 'none'}
        const stored = await this.wagerTransactionRepo.findByExternalId(tx, wager.providerId, wager.referenceExternalTransactionId!)
        if (!stored) return {kind: 'pending'}

        const reference = stored.transaction
        switch (reference.status) {
            case WagerTransactionStatus.Pending:
            case WagerTransactionStatus.PendingReference:
                return {kind: 'pending'}
            case WagerTransactionStatus.Rejected:
            case WagerTransactionStatus.Failed:
                return {kind: 'rejected', code: FailureCode.ReferenceNotProcessed}
        }

        const code = wager.checkReference(reference)
        if (code) return {kind: 'rejected', code}

        // the wallet lock makes this lookup race-free; wager_one_reversal is the backstop
        if (wager.requiresReference() && await this.wagerTransactionRepo.findReversalOf(tx, reference.id)) {
            return {kind: 'rejected', code: FailureCode.AlreadyReversed}
        }
        return {kind: 'found', reference}
    }
}

import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";
import {FailureCode} from "./failureCode.js";
import MoneyProps from "../money/dto/money.props.dto.js";
import {Injectable} from "@nestjs/common";
import {MikroORM} from "@mikro-orm/postgresql";
import {WalletRepository} from "../wallet/wallet.repository.js";
import {WagerTransactionRepository} from "./wagerTransaction.repository.js";
import {WalletLedgerRepository} from "../wallet/walletLedger.repository.js";
import {OutboxRepository} from "../messaging/outbox.repository.js";
import {InboxRepository} from "../messaging/inbox.repository.js";
import {InboxPayloadMismatchError} from "../messaging/errors.js";
import {EntityManager, UniqueConstraintViolationException} from "@mikro-orm/core";
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

    // The same key on two different wallets is not serialised by a wallet lock, so the loser hits a unique index.
    // The whole transaction rolled back, so one retry finds the winner's row and answers as a replay or a conflict.
    // The catch wraps the whole attempt (not one statement): a failed statement aborts the Postgres transaction.
    // A second violation (another unique index) escapes: one retry, never a loop.
    async execute(command: SubmitWagerCommand, ctx?: SubmitWagerContext): Promise<SubmitWagerOutcome> {
        try {
            return await this.attempt(command, ctx)
        } catch (error) {
            if (!(error instanceof UniqueConstraintViolationException)) throw error
            return this.attempt(command, ctx)
        }
    }

    private attempt(command: SubmitWagerCommand, ctx?: SubmitWagerContext): Promise<SubmitWagerOutcome> {
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
            // same id, other content: the provider reused an id (permanent). Same content: an earlier delivery committed, the consumer acks it.
            if (!(await this.inboxRepo.hasPayload(tx, inbox.consumerName, inbox.messageId, inbox.payloadHash))) {
                throw new InboxPayloadMismatchError(inbox.consumerName, inbox.messageId)
            }
            return {kind: 'duplicate-message'}
        }
        const result = await this.process(tx, input)
        if (inbox) await this.inboxRepo.markProcessed(tx, inbox.consumerName, inbox.messageId, input.now)
        return result
    }

    private async process(tx: EntityManager, input: RunInput): Promise<SubmitWagerOutcome> {
        const {command, transactionId, correlationId, causationId, now} = input
        const wallet = await this.lockWallet(tx, command.walletId)
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


        const entry = await this.decide(tx, wallet, wager, now)

        const events = this.buildEvents(wallet, wager, entry, correlationId, causationId, now)
        await this.persist(tx, wallet, wager, entry, events)
        return this.toResult(wager, wallet.balance, false)
    }

    // First statement on the data: serialises everything for this wallet. Null when the wallet does not exist.
    private async lockWallet(tx: EntityManager, walletId: string): Promise<Wallet | null> {
        // Raw SQL: pass the transaction context or it runs on another connection.
        await tx.getConnection().execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, [], 'run', tx.getTransactionContext())
        return this.walletRepo.lockById(tx, walletId)
    }

    // The one place that decides a transaction's outcome, shared by execute and reprocess (HTTP, queue and worker cannot drift).
    // Mutates wager (and wallet when money moves); returns the ledger entry when there is one.
    private async decide(tx: EntityManager, wallet: Wallet, wager: WagerTransaction, now: Date): Promise<WalletLedgerEntry | undefined> {
        const walletFailure = this.checkWallet(wallet, wager)
        if (walletFailure) {
            wager.reject(walletFailure)
            return undefined
        }
        const ref = await this.resolveReference(tx, wager)
        if (ref.kind === 'rejected') wager.reject(ref.code)
        else if (ref.kind === 'pending') {
            // a first attempt is never at the limit; a retry that reaches it gives up (D3)
            if (wager.retryLimitReached()) wager.reject(FailureCode.ReferenceNotFound)
            else wager.markPendingReference(now)
        } else return this.apply(wallet, wager, ref.kind === 'found' ? ref.reference : undefined, now)
        return undefined
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

    private async persist(tx: EntityManager, wallet: Wallet, wager: WagerTransaction, entry: WalletLedgerEntry | undefined, events: IntegrationEvent<unknown>[], exists = false): Promise<void> {
        if (entry) await this.walletRepo.save(tx, wallet)
        // The ledger row references the transaction row, so the transaction goes first.
        const extras = {balanceAfter: wallet.balance.toString()}
        if (exists) await this.wagerTransactionRepo.update(tx, wager, extras)
        else await this.wagerTransactionRepo.insert(tx, wager, extras)
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

    // D8: a well-formed message failed on its last receive. Own transaction, after the first one rolled back, so it only
    // sees committed state. Evidence only: no ledger entry, no event. Unknown wallet: nothing (that message is permanent).
    async recordFailure(command: SubmitWagerCommand, failureCode: FailureCode = FailureCode.ProcessingError): Promise<void> {
        await this.orm.em.fork().transactional(async (tx) => {
            const wallet = await this.lockWallet(tx, command.walletId)
            if (!wallet) return
            // the business call may have committed before the error surfaced, or an earlier receive already recorded this
            if (await this.wagerTransactionRepo.findByIdempotencyKey(tx, command.providerId, command.idempotencyKey)) return
            if (await this.wagerTransactionRepo.findByExternalId(tx, command.providerId, command.externalTransactionId)) return

            const wager = this.buildTransaction(command, randomUUID(), new Date())
            wager.fail(failureCode)
            await this.wagerTransactionRepo.insert(tx, wager, {balanceAfter: wallet.balance.toString()})
        })
    }

    // D3, D18: re-run a PENDING_REFERENCE transaction whose reference may have arrived. One transaction per row.
    async reprocess(transactionId: string, now = new Date()): Promise<void> {
        // Peek outside the transaction: the wallet id is needed to take the lock first (lock order: wallet, then rows).
        const peek = await this.wagerTransactionRepo.findById(this.orm.em.fork(), transactionId)
        if (!peek) return

        await this.orm.em.fork().transactional(async (tx) => {
            const wallet = await this.lockWallet(tx, peek.transaction.walletId)
            if (!wallet) return
            // Re-read under the lock: a concurrent reprocess may have finished it, and the second one has nothing to do.
            const stored = await this.wagerTransactionRepo.findById(tx, transactionId)
            const wager = stored?.transaction
            if (!wager || wager.status !== WagerTransactionStatus.PendingReference) return

            const entry = await this.decide(tx, wallet, wager, now)
            // Still pending: the event went out on the first attempt, only the timeline moves.
            const events = wager.status === WagerTransactionStatus.PendingReference ? []
                : this.buildEvents(wallet, wager, entry, randomUUID(), undefined, now)
            await this.persist(tx, wallet, wager, entry, events, true)
        })
    }
}

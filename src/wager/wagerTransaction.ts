import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";
import {FailureCode} from "./failureCode.js";
import {LedgerDirection} from "../wallet/walletLedgerEntry.js";
import {InvalidTransactionStateError, InvalidWagerTransactionError} from "./errors.js";
import {payloadHash} from "./payloadHash.js";
import {backoffMs} from "./backoff.js";

const pendingStatuses = [
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference
];
const ROLLBACKABLE = [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
];

const ALLOWED_REFERENCE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
    [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
    [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Bet]: [],
    [WagerTransactionKind.Opening]: [],
};

const opposite = (d: LedgerDirection): LedgerDirection =>
    d === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;

export const PENDING_REFERENCE_BACKOFF = {baseMs: 20_000, capMs: 120_000} as const;
export const MAX_REFERENCE_RETRIES = 3;

export interface CreateWagerTransactionProps {
    id: string,
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
    walletId: string,
    playerId: string,
    roundId: string,
    gameId: string,
    kind: WagerTransactionKind,
    money: Money,
    referenceExternalTransactionId?: string,
    now: Date
}

export interface WagerTransactionState {
    id: string,
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
    payloadHash: string,
    walletId: string,
    playerId: string,
    roundId: string,
    gameId: string,
    kind: WagerTransactionKind,
    money: Money,
    referenceExternalTransactionId: string | undefined
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string
    failureCode?: FailureCode,
    processedAt?: Date,
    attempts: number,
    nextAttemptAt?: Date
}

export default class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        /** id no provedor — não o id interno */
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
        private _attempts: number = 0,
        private _nextAttemptAt?: Date,
    ) {
    }

    /** Nasce em PENDING. Valida a exigência de referência por kind. */
    static create(_props: CreateWagerTransactionProps): WagerTransaction {
        if (_props.id.trim() === '') {
            throw new InvalidWagerTransactionError('id must not be blank')
        }
        if (_props.providerId.trim() === '') {
            throw new InvalidWagerTransactionError('providerId must not be blank')
        }
        if (_props.externalTransactionId.trim() === '') {
            throw new InvalidWagerTransactionError('externalTransactionId must not be blank')
        }
        if (_props.roundId.trim() === '') {
            throw new InvalidWagerTransactionError('roundId must not be blank')
        }
        if (_props.gameId.trim() === '') {
            throw new InvalidWagerTransactionError('gameId must not be blank')
        }
        if (_props.idempotencyKey.trim() === '') {
            throw new InvalidWagerTransactionError('idempotencyKey must not be blank')
        }
        if (_props.walletId.trim() === '') {
            throw new InvalidWagerTransactionError('walletId must not be blank')
        }
        if (_props.playerId.trim() === '') {
            throw new InvalidWagerTransactionError('playerId must not be blank')
        }
        if (_props.referenceExternalTransactionId === '') {
            throw new InvalidWagerTransactionError('referenceExternalTransactionId must not be empty')
        }

        let hash: string = payloadHash(_props)


        switch (_props.kind) {
            case WagerTransactionKind.Bet:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('BET amount must be greater than 0')
                    }
                } else {
                    throw new InvalidWagerTransactionError('BET must not have a reference')
                }
                break;
            case WagerTransactionKind.Win:

                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('WIN amount must be greater than 0')
                    }
                    //created
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero()) {
                        throw new InvalidWagerTransactionError('WIN amount must be greater than 0')
                    }
                }
                break;
            case WagerTransactionKind.Loss:
                if (_props.referenceExternalTransactionId === undefined) {

                    if (!_props.money.isZero() && !_props.money.isPositive()) {
                        throw new InvalidWagerTransactionError('LOSS amount must be 0 or more')
                    }
                } else {
                    if (_props.money.isZero() || _props.money.isPositive()) {
                        //created
                    }
                }
                break;
            case WagerTransactionKind.Refund:
                if (_props.referenceExternalTransactionId === undefined) {

                    if (_props.money.isPositive() || _props.money.isZero()) {
                        throw new InvalidWagerTransactionError('REFUND requires a reference')
                    }
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('REFUND amount must be greater than 0')
                    }
                }
                break;
            case WagerTransactionKind.Rollback:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isPositive() || _props.money.isZero()) {
                        throw new InvalidWagerTransactionError('ROLLBACK requires a reference')
                    }
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('ROLLBACK amount must be greater than 0')
                    }
                }
                break;
            case WagerTransactionKind.Opening:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero()) {
                        throw new InvalidWagerTransactionError('OPENING amount must be greater than 0')
                    }
                } else {

                    if (_props.money.isPositive() || _props.money.isZero()) {
                        throw new InvalidWagerTransactionError('OPENING must not have a reference')
                    }
                }
                break;
        }

        if (_props.money.isNegative()) {
            throw new InvalidWagerTransactionError(`${_props.kind} amount must not be negative`)
        }

        return new WagerTransaction(
            _props.id,
            _props.providerId,
            _props.externalTransactionId,
            _props.idempotencyKey,
            hash,
            _props.walletId,
            _props.playerId,
            _props.roundId,
            _props.gameId,
            _props.kind,
            _props.money,
            _props.referenceExternalTransactionId,
            _props.now,
            WagerTransactionStatus.Pending,
            undefined,
            undefined,
            undefined,
            0,
            undefined
        )
    }

    static rehydrate(_state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            _state.id,
            _state.providerId,
            _state.externalTransactionId,
            _state.idempotencyKey,
            _state.payloadHash,
            _state.walletId,
            _state.playerId,
            _state.roundId,
            _state.gameId,
            _state.kind,
            _state.money,
            _state.referenceExternalTransactionId,
            _state.createdAt,
            _state.status,
            _state.referenceTransactionId,
            _state.failureCode,
            _state.processedAt,
            _state.attempts,
            _state.nextAttemptAt,
        )
    }

    get attempts(): number {
        return this._attempts;
    }

    get nextAttemptAt(): Date | undefined {
        return this._nextAttemptAt;
    }

    get status(): WagerTransactionStatus {
        return this._status;
    }

    get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }

    get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }

    get processedAt(): Date | undefined {
        return this._processedAt;
    }

    // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
    markProcessed(_referenceTransactionId: string | undefined, _at: Date): void {
        this.assertPending(WagerTransactionStatus.Processed)
        this._referenceTransactionId = _referenceTransactionId
        this._processedAt = _at
        this._nextAttemptAt = undefined
        this._status = WagerTransactionStatus.Processed
    }

    markPendingReference(now: Date): void {
        this.assertPending(WagerTransactionStatus.PendingReference);
        if (this.retryLimitReached()) throw new Error('retry limit reached: reject instead');   // caller bug
        this._attempts = this.status === WagerTransactionStatus.Pending ? 0 : this._attempts + 1;
        this._status = WagerTransactionStatus.PendingReference;
        this._nextAttemptAt = new Date(now.getTime() + backoffMs(this._attempts, PENDING_REFERENCE_BACKOFF.baseMs, PENDING_REFERENCE_BACKOFF.capMs));
    }

    retryLimitReached(): boolean {
        return this.status === WagerTransactionStatus.PendingReference && this._attempts >= MAX_REFERENCE_RETRIES - 1;
    }

    reject(_code: FailureCode): void {
        this.assertPending(WagerTransactionStatus.Rejected)

        if (_code === FailureCode.ProcessingError) {
            throw new Error('PROCESSING_ERROR is only valid for FAILED')
        }
        this._status = WagerTransactionStatus.Rejected
        this._failureCode = _code
        this._nextAttemptAt = undefined
    }

    fail(_code: FailureCode): void {
        this.assertPending(WagerTransactionStatus.Failed)
        if (_code === FailureCode.ProcessingError) {

            this._status = WagerTransactionStatus.Failed
            this._failureCode = _code
            this._nextAttemptAt = undefined
        } else {
            throw new Error('Only processinErro accepted')
        }
    }

    // ---- consultas de domínio
    isTerminal(): boolean {
        return !pendingStatuses.includes(this.status)
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }      // false para LOSS
    requiresReference(): boolean {
        return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    }   // true para REFUND e ROLLBACK

    hasReference(): boolean {
        return this.referenceExternalTransactionId !== undefined
    }

    matchesPayload(_payloadHash: string): boolean {
        return this.payloadHash === _payloadHash;
    }

    ledgerDirectionFor(_reference?: WagerTransaction): LedgerDirection {
        switch (this.kind) {
            case WagerTransactionKind.Opening:
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
                return LedgerDirection.Credit;
            case WagerTransactionKind.Bet:
                return LedgerDirection.Debit;
            case WagerTransactionKind.Loss:
                throw new Error('LOSS has no ledger movement');          // caller must check affectsBalance()
            case WagerTransactionKind.Rollback:
                if (!_reference) throw new Error('ROLLBACK needs its reference');
                if (!ROLLBACKABLE.includes(_reference.kind)) {
                    throw new Error(`ROLLBACK cannot undo ${_reference.kind}`);   // checkReference should have rejected it earlier
                }
                // a rollback undoes the reference, so it is the opposite of the reference's own direction
                return opposite(_reference.ledgerDirectionFor());                  // BET, WIN, REFUND never need a reference
        }
    }

    private assertPending(to: WagerTransactionStatus): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(this.status, to)
        }
    }

    checkReference(reference: WagerTransaction): FailureCode | null {
        if (this.providerId !== reference.providerId || this.playerId !== reference.playerId
            || this.walletId !== reference.walletId || this.roundId !== reference.roundId
            || this.money.currency !== reference.money.currency) {
            return FailureCode.ReferenceMismatch;
        }
        if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
            return FailureCode.InvalidReferenceKind;
        }
        if (this.requiresReference() && !this.money.equals(reference.money)) {
            return FailureCode.ReversalAmountMismatch;
        }
        return null;
    }
}
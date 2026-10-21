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
    _status: WagerTransactionStatus,
    _referenceTransactionId?: string
    _failureCode?: FailureCode,
    _processedAt?: Date,
    _attempts: number,
    _nextAttemptAt?: Date
}

const notImplemented = (): never => {
    throw new Error("not implemented");
};

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
        if ( _props.id.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.providerId.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.externalTransactionId.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.roundId.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.gameId.trim() === '' ) {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.idempotencyKey.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.walletId.trim() === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if ( _props.playerId.trim() === '' ) {
            throw new InvalidWagerTransactionError('invalid id')
        }
        if (_props.referenceExternalTransactionId === '') {
            throw new InvalidWagerTransactionError('invalid id')
        }

        let hash: string = payloadHash(_props)


        switch (_props.kind) {
            case WagerTransactionKind.Bet:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('forbidden reference')
                    }
                } else {
                    throw new InvalidWagerTransactionError('Reference should not exist for Bet kind')
                }
                break;
            case WagerTransactionKind.Win:

                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('no valid zero values')
                    }
                    //created
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero()) {
                        throw new InvalidWagerTransactionError('no valid zero values')
                    }
                }
                break;
            case WagerTransactionKind.Loss:
                if (_props.referenceExternalTransactionId === undefined) {

                    if (!_props.money.isZero() && !_props.money.isPositive()) {
                        throw new InvalidWagerTransactionError('no valid minus values')
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
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                }
                break;
            case WagerTransactionKind.Rollback:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isPositive() || _props.money.isZero()) {
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                } else {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero() || _props.money.isNegative()) {
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                }
                break;
            case WagerTransactionKind.Opening:
                if (_props.referenceExternalTransactionId === undefined) {
                    if (_props.money.isPositive()) {
                        //created
                    }
                    if (_props.money.isZero()) {
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                } else {

                    if (_props.money.isPositive() || _props.money.isZero()) {
                        throw new InvalidWagerTransactionError('requires reference')
                    }
                }
                break;
        }

        if (_props.money.isNegative()) {
            throw new InvalidWagerTransactionError('ANything that is not loss is not allow negative')
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
            _props.now,
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
            _state._status,
            _state._referenceTransactionId,
            _state._failureCode,
            _state._processedAt,
            _state._attempts,
            _state._nextAttemptAt,
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
        this.assertPending()
        this._referenceTransactionId = _referenceTransactionId
        this._processedAt = _at
        this._nextAttemptAt = undefined
    }

    markPendingReference(now: Date): void {
        this.assertPending();
        if (this.retryLimitReached()) throw new Error('retry limit reached: reject instead');   // caller bug
        this._attempts = this.status === WagerTransactionStatus.Pending ? 0 : this._attempts + 1;
        this._status = WagerTransactionStatus.PendingReference;
        this._nextAttemptAt = new Date(now.getTime() + backoffMs(this._attempts, PENDING_REFERENCE_BACKOFF.baseMs, PENDING_REFERENCE_BACKOFF.capMs));
    }

    retryLimitReached(): boolean {
        return this.status === WagerTransactionStatus.PendingReference && this._attempts >= MAX_REFERENCE_RETRIES - 1;
    }

    reject(_code: FailureCode): void {
        this.assertPending()

        if (_code === FailureCode.ProcessingError) {
            return;
        }
        this._status = WagerTransactionStatus.Rejected
        this._failureCode = _code
        this._nextAttemptAt = undefined
    }

    fail(_code: FailureCode): void {
        this.assertPending()
        if (_code === FailureCode.ProcessingError) {

            this._status = WagerTransactionStatus.Failed
            this._failureCode = _code
            this._nextAttemptAt = undefined
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
                // a rollback undoes the reference, so it is the opposite of the reference's own direction
                return opposite(_reference.ledgerDirectionFor());                  // BET, WIN, REFUND never need a reference
        }
    }

    private assertPending(): void {
        if (!pendingStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(this.status, WagerTransactionStatus.Processed)
        }
    }

    /*
        static assertWagerTransactionReference(_props: CreateWagerTransactionProps){
            if(_props.kind === 'BET'){
                if(_props.referenceExternalTransactionId != null)
            }
        }*/
}
import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";
import {FailureCode} from "./failureCode.js";
import {LedgerDirection} from "../wallet/walletLedgerEntry.js";
import {InvalidTransactionStateError} from "./errors.js";

const pendingStatuses = [
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference
];
// todo: shapes undecided, see progress-log.md ("WagerTransaction stubs")
interface CreateWagerTransactionProps {
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

interface WagerTransactionState {
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
    attempts: number,
    nextAttemptAt?: Date
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
    ) {
    }

    /** Nasce em PENDING. Valida a exigência de referência por kind. */
    static create(_props: CreateWagerTransactionProps): WagerTransaction {

        return notImplemented();
    }

    static rehydrate(_state: WagerTransactionState): WagerTransaction {
        return notImplemented();
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
        if (!pendingStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(this.status, WagerTransactionStatus.Processed)
        }
        notImplemented();
    }

    markPendingReference(): void {
        if (!pendingStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(this.status, WagerTransactionStatus.PendingReference)
        }
        notImplemented();
    }

    reject(_code: FailureCode): void {
        if (!pendingStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(this.status, WagerTransactionStatus.Rejected)
        }
        notImplemented();
    }

    fail(_code: FailureCode): void {
        if (!pendingStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(this.status, WagerTransactionStatus.Failed)
        }
        notImplemented();
    }

    // ---- consultas de domínio
    isTerminal(): boolean {
        return notImplemented();
    }

    affectsBalance(): boolean {
        return notImplemented();
    }      // false para LOSS
    requiresReference(): boolean {
        return notImplemented();
    }   // true para REFUND e ROLLBACK
    matchesPayload(_payloadHash: string): boolean {
        return notImplemented();
    }

    ledgerDirectionFor(_reference?: WagerTransaction): LedgerDirection {
        return notImplemented();
    }

    static assertWagerTransactionReference(_props: CreateWagerTransactionProps){
        if(_props.kind === 'BET'){
            if(_props.referenceExternalTransactionId != null)
        }
    }
}
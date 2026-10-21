export enum FailureCode {
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    InsufficientFundsForReversal = "INSUFFICIENT_FUNDS_FOR_REVERSAL",
    ReferenceNotFound = "REFERENCE_NOT_FOUND",
    ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
    ReferenceMismatch = "REFERENCE_MISMATCH",
    InvalidReferenceKind = "INVALID_REFERENCE_KIND",
    ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
    CurrencyMismatch = "CURRENCY_MISMATCH",
    PlayerMismatch = "PLAYER_MISMATCH",
    AlreadyReversed = "ALREADY_REVERSED",
    ProcessingError = "PROCESSING_ERROR" // only valid for FAILED
}

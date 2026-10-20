class InvalidMoneyError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "InvalidMoneyError";
        Object.setPrototypeOf(this, InvalidMoneyError.prototype);
    }
}

class CurrencyMismatchError extends Error {
    constructor(expected: string, received: string) {
        super(`Expected: ${expected}, received : ${received}`)
        this.name = "CurrencyMismatchError";
        Object.setPrototypeOf(this, CurrencyMismatchError.prototype);
    }
}

export {InvalidMoneyError, CurrencyMismatchError}
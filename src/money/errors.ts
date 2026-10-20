class InvalidMoneyError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "InvalidMoneyError";
        Object.setPrototypeOf(this, InvalidMoneyError.prototype);
    }
}

class CurrencyMistMatchError extends Error {
    constructor(expected: string, received: string) {
        super(`Expected: ${expected}, received : ${received}`)
        this.name = "CurrencyMistMatchError";
        Object.setPrototypeOf(this, CurrencyMistMatchError.prototype);
    }
}

export {InvalidMoneyError, CurrencyMistMatchError}
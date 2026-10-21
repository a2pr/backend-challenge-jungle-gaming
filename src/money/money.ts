import MoneyProps from './dto/money.props.dto.js';
import {Decimal} from 'decimal.js';
import {InvalidMoneyError, CurrencyMismatchError} from "./errors.js";

const regexCurrency = /^[A-Z]{3}$/;
const regexValue = /^-?\d+\.\d{2}$/;
export default class Money {
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) {
    }

    static from(props: MoneyProps): Money {
        if (!regexCurrency.test(props.currency)) {
            throw new InvalidMoneyError('Not valid currency for money');
        }
        if (!regexValue.test(props.amount)) {
            throw new InvalidMoneyError('Not value for money');
        }
        let amount = new Decimal(props.amount);
        if (amount.lt(0)) {
            throw new InvalidMoneyError('Not value for money');
        }
        return new Money(new Decimal(props.amount), props.currency);
    }

    static zero(currency: string): Money {
        if (!regexCurrency.test(currency)) {
            throw new InvalidMoneyError('Not valid currency for money');
        }
        return new Money(new Decimal('0.00'), currency);
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);

        return new Money(this.value.plus(other.value), this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);

        return new Money(this.value.minus(other.value), this.currency);
    }

    negate(): Money {
        return new Money(this.value.neg(), this.currency);
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isPositive(): boolean {
        return this.value.gt(0);
    }

    isNegative(): boolean {
        return this.value.lt(0);
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lessThan(other.value);
    }

    equals(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.equals(other.value);
    }

    toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }

    toString(): string {
        return this.value.toFixed(2);
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }
}

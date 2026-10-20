import Money from '../money/money.js';

export default class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  /**
     static rehydrate(state: WalletState): Wallet {
     //todo
     }
     */

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // Aplicam a movimentação mantendo saldo e ledger consistentes entre si.
  // Assinatura e retorno são decisão sua.
  debit(/* ... */): void {
    //todo
  }

  credit(/* ... */): void {
    //todo
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw Error('not same currency issue ');
    }
  }
}

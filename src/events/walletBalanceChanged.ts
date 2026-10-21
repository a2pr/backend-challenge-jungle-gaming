import {EventContext, IntegrationEvent} from "./integrationEvent.js";
import Wallet from "../wallet/wallet.js";
import WalletLedgerEntry, {LedgerDirection} from "../wallet/walletLedgerEntry.js";
import MoneyProps from "../money/dto/money.props.dto.js";

interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    readonly eventType = "WalletBalanceChanged";
    readonly version = 1;

    // Call after wallet.debit / wallet.credit, so wallet.version is the one this change produced.
    static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
        return new WalletBalanceChanged({
            ...ctx,
            aggregateId: wallet.id,
            data: {
                walletId: wallet.id,
                transactionId: entry.transactionId,
                direction: entry.direction,
                money: entry.money.toJSON(),           // MoneyProps strings, never Money instances
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: wallet.version,
            },
        });
    }
}

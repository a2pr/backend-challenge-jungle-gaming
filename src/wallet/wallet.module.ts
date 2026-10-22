import {Module} from "@nestjs/common";
import {MessagingModule} from "../messaging/messaging.module.js";
import {WalletRepository} from "./wallet.repository.js";
import {WalletLedgerRepository} from "./walletLedger.repository.js";
import {WagerTransactionRepository} from "../wager/wagerTransaction.repository.js";
import {CreateWalletUseCase} from "./createWallet.usecase.js";
import {WalletController} from "./wallet.controller.js";
import {WageringController} from "../wager/wagering.controller.js";
import {SubmitWagerTransactionUseCase} from "../wager/SubmitWagerTransaction.usecase.js";
import {WagerConsumer} from "../messaging/wagerConsumer.js";
import {PendingReferenceWorker} from "../messaging/pendingReferenceWorker.js";

// One module owns the whole financial flow: wallet and wager repositories are used together in every transaction,
// and two modules would import each other (circular). Step 4 adds SubmitWagerTransactionUseCase here.
@Module({
    imports: [MessagingModule],
    controllers: [WalletController, WageringController],
    providers: [WalletRepository, WalletLedgerRepository, WagerTransactionRepository, CreateWalletUseCase, SubmitWagerTransactionUseCase,
        // they call the use case, so they live next to it (MessagingModule cannot import this module back)
        WagerConsumer, PendingReferenceWorker],
})
export class WalletModule {}

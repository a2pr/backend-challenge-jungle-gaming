import {Module} from "@nestjs/common";
import {OutboxRepository} from "./outbox.repository.js";
import {InboxRepository} from "./inbox.repository.js";
import {OutboxPublisher} from "./outboxPublisher.js";
import {sqsProvider} from "./sqs.provider.js";
import {MESSAGING_CONFIG, messagingConfig} from "./messaging.config.js";

@Module({
    providers: [OutboxRepository, InboxRepository, sqsProvider, OutboxPublisher,
        {provide: MESSAGING_CONFIG, useFactory: messagingConfig}],
    exports: [OutboxRepository, InboxRepository, sqsProvider, MESSAGING_CONFIG],
})
export class MessagingModule {}

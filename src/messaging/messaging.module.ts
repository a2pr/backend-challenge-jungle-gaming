import {Module} from "@nestjs/common";
import {OutboxRepository} from "./outbox.repository.js";
import {InboxRepository} from "./inbox.repository.js";
import {sqsProvider} from "./sqs.provider.js";

@Module({
    providers: [OutboxRepository, InboxRepository, sqsProvider],
    exports: [OutboxRepository, InboxRepository, sqsProvider],
})
export class MessagingModule {}

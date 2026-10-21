import {Module} from "@nestjs/common";
import {OutboxRepository} from "./outbox.repository.js";
import {InboxRepository} from "./inbox.repository.js";

@Module({
    providers: [OutboxRepository, InboxRepository],
    exports: [OutboxRepository, InboxRepository],
})
export class MessagingModule {}

import {Provider} from "@nestjs/common";
import {SQSClient} from "@aws-sdk/client-sqs";

export const SQS_CLIENT = Symbol('SQS_CLIENT');

// Endpoint, region and credentials come from AWS_* env vars. maxAttempts 1: the outbox and the consumer own the retry policy.
export const sqsProvider: Provider = {provide: SQS_CLIENT, useFactory: () => new SQSClient({maxAttempts: 1})};

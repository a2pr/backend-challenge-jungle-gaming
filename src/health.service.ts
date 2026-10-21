import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from './messaging/sqs.provider.js';
import { MESSAGING_CONFIG, type MessagingConfig } from './messaging/messaging.config.js';

const PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  getLive(): boolean {
    return true;
  }

  async getReady(): Promise<Record<string, boolean>> {
    const [postgres, sqs] = await Promise.all([
      this.probe(
        async () => !!(await this.orm.em.getConnection().execute('select 1')),
      ),
      // fails when the queue is missing, not only when SQS is unreachable
      this.probe(
        async () =>
          !!(await this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: this.config.wagerQueueUrl,
              AttributeNames: ['QueueArn'],
            }),
          )),
      ),
    ]);
    return { postgres, sqs };
  }

  private probe(check: () => Promise<boolean>): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(resolve, PROBE_TIMEOUT_MS, false),
    );
    return Promise.race([check().catch(() => false), timeout]);
  }
}

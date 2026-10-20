import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';

const PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  // endpoint/region/credentials come from AWS_* env vars (see docker-compose.yaml)
  // ponytail: own client for now, extract a shared provider when the consumer needs one
  private readonly sqs = new SQSClient({ maxAttempts: 1 });

  constructor(private readonly orm: MikroORM) {}

  getLive(): boolean {
    return true;
  }

  async getReady(): Promise<Record<string, boolean>> {
    const [postgres, sqs] = await Promise.all([
      this.probe(async () => !!(await this.orm.em.getConnection().execute('select 1'))),
      // reachability only; switch to GetQueueAttributes on wager-transactions.fifo once queues are provisioned
      this.probe(async () => !!(await this.sqs.send(new ListQueuesCommand({ MaxResults: 1 })))),
    ]);
    return { postgres, sqs };
  }

  private probe(check: () => Promise<boolean>): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS, false));
    return Promise.race([check().catch(() => false), timeout]);
  }
}

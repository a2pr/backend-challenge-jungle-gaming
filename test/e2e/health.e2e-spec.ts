import {DeleteQueueCommand, CreateQueueCommand} from '@aws-sdk/client-sqs';
import {createTestApp} from '../support/app.js';
import {createTestQueues, sqs} from '../support/sqs.js';
import {MESSAGING_CONFIG, messagingConfig} from '../../src/messaging/messaging.config.js';

describe('/health/ready reads the main queue', () => {
    it('is 503 when the main queue does not exist and 200 once it does', async () => {
        const queues = await createTestQueues();
        const {app, http} = await createTestApp((b) =>
            b.overrideProvider(MESSAGING_CONFIG).useValue({...messagingConfig(), ...queues}));
        try {
            await http.get('/health/ready').expect(200);

            await sqs.send(new DeleteQueueCommand({QueueUrl: queues.wagerQueueUrl}));
            const res = await http.get('/health/ready').expect(503);
            expect(res.body.details).toMatchObject({postgres: true, sqs: false});

            await sqs.send(new CreateQueueCommand({
                QueueName: queues.wagerQueueUrl.split('/').pop()!, Attributes: {FifoQueue: 'true'},
            }));
            await http.get('/health/ready').expect(200);
        } finally {
            await app.close();
        }
    });
});

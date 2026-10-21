import {INestApplication} from '@nestjs/common';
import {createTestApp} from '../support/app.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let http: Awaited<ReturnType<typeof createTestApp>>['http'];

  beforeEach(async () => {
    ({app, http} = await createTestApp());
  });

  it('the global filter answers with the error body shape, not Nest\'s default', async () => {
    const res = await http.get('/no-such-route').expect(404);
    expect(res.body).toMatchObject({status: 404, code: 'HTTP_ERROR', retryable: false});
  });

  afterEach(async () => {
    await app.close();
  });

  // No auth header is sent: health stays public (README §9).
  it('/health/live (GET)', () => http.get('/health/live').expect(200).expect('OK'));
  it('/health/ready (GET)', () => http.get('/health/ready').expect(200).expect('OK'));
});

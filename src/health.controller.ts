import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  @Get('live')
  getLive(): string {
    return this.service.getLive() ? 'OK' : 'NOT OK';
  }

  @Get('ready')
  async getReady(): Promise<string> {
    const checks = await this.service.getReady();
    if (Object.values(checks).includes(false))
      throw new ServiceUnavailableException(checks);
    return 'OK';
  }
}

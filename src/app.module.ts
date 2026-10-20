import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [ HealthController],
  providers: [ HealthService],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import config from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [AppController, HealthController],
  providers: [AppService, HealthService],
})
export class AppModule {}

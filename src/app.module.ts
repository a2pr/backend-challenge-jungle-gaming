import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { WalletModule } from './wallet/wallet.module.js';

@Module({
  imports: [MikroOrmModule.forRoot(config), MessagingModule, WalletModule],
  controllers: [ HealthController],
  providers: [ HealthService],
})
export class AppModule {}

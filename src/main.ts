import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './http/configureApp.js';
import { logEvent } from './observability/logEvent.js';

async function bootstrap() {
  const logger = new ConsoleLogger({ json: true });
  const app = await NestFactory.create(AppModule, { logger });
  configureApp(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logEvent(logger, 'app.started', { port });   // logEvent adds instanceId, like every other line
}
await bootstrap();

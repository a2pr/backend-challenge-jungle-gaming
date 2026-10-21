import {INestApplication} from "@nestjs/common";
import {DomainExceptionFilter} from "./domainException.filter.js";

// Shared by main.ts and the e2e tests so production and tests cannot drift apart.
export function configureApp(app: INestApplication): void {
    app.useGlobalFilters(new DomainExceptionFilter());
    app.enableShutdownHooks();   // phase 7: graceful shutdown of the workers
}

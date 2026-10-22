import {Global, Module} from "@nestjs/common";
import {MetricsController} from "./metrics.controller.js";
import {MetricsService} from "./metrics.service.js";

// Global: the use case, consumer, publisher and controllers all write to the one registry.
@Global()
@Module({controllers: [MetricsController], providers: [MetricsService], exports: [MetricsService]})
export class ObservabilityModule {}

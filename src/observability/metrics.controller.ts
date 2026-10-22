import {Controller, Get, Res} from "@nestjs/common";
import type {Response} from "express";
import {MetricsService} from "./metrics.service.js";

// Public like /health/*: no AuthGuard (D15).
@Controller('metrics')
export class MetricsController {
    constructor(private readonly metrics: MetricsService) {
    }

    @Get()
    async scrape(@Res({passthrough: true}) res: Response): Promise<string> {
        res.type(this.metrics.contentType);
        return this.metrics.render();
    }
}

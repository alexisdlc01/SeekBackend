import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { SkipThrottle } from "@nestjs/throttler";
import { Connection } from "mongoose";
import { AppService } from "./app.service";

@Controller()
export class AppController {
	constructor(
		private readonly appService: AppService,
		@InjectConnection() private readonly connection: Connection
	) {}

	@Get()
	getHello(): string {
		return this.appService.getHello();
	}

	// Render healthCheckPath: public, not rate limited, 503 when Mongo is down.
	@SkipThrottle({ default: true, auth: true })
	@Get("health")
	health() {
		if (this.connection.readyState !== 1) {
			throw new ServiceUnavailableException({ status: "down" });
		}
		return { status: "ok" };
	}
}

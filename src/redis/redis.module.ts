import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Module({
	providers: [
		{
			provide: "REDIS_CLIENT",
			inject: [ConfigService],
			useFactory: (config: ConfigService) => {
				return new Redis(config.getOrThrow("REDIS_URL"));
			}
		}
	],
	exports: ["REDIS_CLIENT"]
})
export class RedisModule {}

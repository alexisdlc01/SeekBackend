import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";

@Module({
	imports: [
		ThrottlerModule.forRoot({
			throttlers: [
				{
					ttl: 60,
					limit: 3
				}
			]
		})
	],
	controllers: [UploadController],
	providers: [
		UploadService,
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard
		}
	]
})
export class UploadModule {}

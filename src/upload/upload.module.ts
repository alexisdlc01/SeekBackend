import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { SharedModule } from "../shared/shared.module";

@Module({
	imports: [
		ThrottlerModule.forRoot({
			throttlers: [
				{
					ttl: 60,
					limit: 3
				}
			]
		}),
		SharedModule
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

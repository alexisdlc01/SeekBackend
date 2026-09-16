import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { SharedModule } from "../shared/shared.module";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "../listings/listings.schema";
import { User, UserSchema } from "../users/users.schema";
import {
	Application,
	ApplicationSchema
} from "../application/application.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Listing.name, schema: ListingSchema },
			{ name: User.name, schema: UserSchema },
			{ name: Application.name, schema: ApplicationSchema }
		]),
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

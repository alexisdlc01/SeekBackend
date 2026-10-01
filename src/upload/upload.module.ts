import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";
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
		SharedModule
	],
	controllers: [UploadController],
	providers: [UploadService]
})
export class UploadModule {}

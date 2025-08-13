import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "./listings.schema";
import { User, UserSchema } from "../users/users.schema";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { SharedModule } from "../shared/shared.module";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Listing.name,
				schema: ListingSchema
			},
			{ name: User.name, schema: UserSchema }
		]),
		SharedModule
	],
	controllers: [ListingsController],
	providers: [ListingsService]
})
export class ListingsModule {}

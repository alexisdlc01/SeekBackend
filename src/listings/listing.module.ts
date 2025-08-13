import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "./listings.schema";
import { User, UserSchema } from "../users/users.schema";
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Listing.name,
				schema: ListingSchema
			},
			{ name: User.name, schema: UserSchema }
		])
	],
	controllers: [ListingsController],
	providers: [ListingsService]
})
export class ListingsModule {}

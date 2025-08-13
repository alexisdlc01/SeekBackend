import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "./listings.schema";
import { User, UserSchema } from "../users/users.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Listing.name,
				schema: ListingSchema
			},
			{ name: User.name, schema: UserSchema }
		])
	]
})
export class ListingsModule {}

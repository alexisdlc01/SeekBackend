import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "./listings.schema";
import { User, UserSchema } from "../users/users.schema";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { SharedModule } from "../shared/shared.module";
import { AuthModule } from "../auth/auth.module";
import { ListingsGateway } from "./listings.gateway";
import UsersService from "../users/users.service";
import { UsersModule } from "../users/users.module";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Listing.name,
				schema: ListingSchema
			},
			{ name: User.name, schema: UserSchema }
		]),
		SharedModule,
		AuthModule,
		UsersModule
	],
	controllers: [ListingsController],
	providers: [ListingsService, ListingsGateway],
	exports: [ListingsService]
})
export class ListingsModule {}

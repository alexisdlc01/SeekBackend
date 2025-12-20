import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "./users.schema";
import { SharedModule } from "../shared/shared.module";
import { PresenceService } from './presence.service';
import { RedisModule } from "../redis/redis.module";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: User.name,
				schema: UserSchema
			}
		]),
		SharedModule,
		RedisModule
	],
	controllers: [UsersController],
	providers: [UsersService, PresenceService],
	exports: [UsersService]
})
export class UsersModule {}

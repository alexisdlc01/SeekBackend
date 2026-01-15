import { Module } from "@nestjs/common";
import { FlagsService } from "./flags.service";
import { FlagsController } from "./flags.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Flag, FlagSchema } from "./flags.schema";
import { SharedModule } from "src/shared/shared.module";
import { User, UserSchema } from "src/users/users.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Flag.name,
				schema: FlagSchema
			},
			{
				name: User.name,
				schema: UserSchema
			}
		]),
		SharedModule
	],
	controllers: [FlagsController],
	providers: [FlagsService]
})
export class FlagsModule {}

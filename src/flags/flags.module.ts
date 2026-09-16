import { Module } from "@nestjs/common";
import { FlagsService } from "./flags.service";
import { FlagsController } from "./flags.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Flag, FlagSchema } from "./flags.schema";
import { SharedModule } from "../shared/shared.module";
import { User, UserSchema } from "../users/users.schema";
import { AuthModule } from "../auth/auth.module";

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
		SharedModule,
		AuthModule
	],
	controllers: [FlagsController],
	providers: [FlagsService]
})
export class FlagsModule {}

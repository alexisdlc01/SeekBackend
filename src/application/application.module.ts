import { Module } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { ApplicationController } from "./application.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Application, ApplicationSchema } from "./application.schema";
import { ListingsModule } from "../listings/listing.module";
import { SharedModule } from "../shared/shared.module";
import { ConversationService } from "src/conversation/conversation.service";
import { ConversationModule } from "src/conversation/conversation.module";
import { Conversation, ConversationSchema } from "src/conversation/converstaion.schema";
import { UsersModule } from "src/users/users.module";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Application.name,
				schema: ApplicationSchema
			}
		]),
		MongooseModule.forFeature([
			{
				name: Conversation.name,
				schema: ConversationSchema
			}
		]),
		ListingsModule,
		SharedModule,
		ConversationModule,
		UsersModule
	],
	controllers: [ApplicationController],
	providers: [ApplicationService]
})
export class ApplicationModule { }

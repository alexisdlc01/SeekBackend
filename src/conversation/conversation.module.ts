import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Conversation, ConversationSchema } from "./converstaion.schema";
import { ConversationController } from "./conversation.controller";
import { ConversationGateway } from "./conversation.gateway";
import { ConversationService } from "./conversation.service";
import { Message, MessageSchema } from "./message.schema";
import { UsersModule } from "../users/users.module";
import { Application, ApplicationSchema } from "../application/application.schema";
import { ConversationAccessService } from "./conversation-access.service";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Conversation.name,
				schema: ConversationSchema
			}
		]),
		MongooseModule.forFeature([
			{
				name: Message.name,
				schema: MessageSchema
			},
			{
				name: Application.name,
				schema: ApplicationSchema
			}
		]),
		UsersModule,
		SharedModule,
	],
	controllers: [ConversationController],
	providers: [ConversationAccessService, ConversationGateway, ConversationService],
	exports: [ConversationAccessService],
})
export class ConversationModule { }

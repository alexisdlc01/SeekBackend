import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Conversation, ConversationSchema } from "./converstaion.schema";
import { ConversationController } from "./conversation.controller";
import { ConversationGateway } from "./conversation.gateway";
import { ConversationService } from "./conversation.service";
import { MessageModule } from "../message/message.module";
import { Message, MessageSchema } from "./message.schema";
import { UsersModule } from "../users/users.module";

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
			}
		]),
		UsersModule,
		SharedModule
	],
	controllers: [ConversationController],
	providers: [ConversationGateway, ConversationService]
})
export class ConversationModule {}

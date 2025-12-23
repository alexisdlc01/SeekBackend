import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Conversation, ConversationSchema } from "./converstaion.schema";
import { ConversationController } from './conversation.controller';

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Conversation.name,
				schema: ConversationSchema
			}
		]),
		SharedModule
	],
	controllers: [ConversationController]
})
export class ConversationModule {}

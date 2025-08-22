import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Conversation, ConversationSchema } from "./converstaion.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Conversation.name,
				schema: ConversationSchema
			}
		]),
		SharedModule
	]
})
export class ConversationModule {}

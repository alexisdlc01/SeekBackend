import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConversationModule } from "../conversation/conversation.module";
import { Message, MessageSchema } from "../conversation/message.schema";
import { SharedModule } from "../shared/shared.module";
import { ListingsModule } from "../listings/listing.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { AnthropicClient } from "./anthropic.client";
import { GeminiClient } from "./gemini.client";
import { LlmClient } from "./llm.client";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

@Module({
	imports: [
		MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
		SharedModule,
		ListingsModule,
		TenanciesModule,
		ConnectorsModule,
		ConversationModule
	],
	controllers: [AiController],
	providers: [AiService, GeminiClient, AnthropicClient, LlmClient]
})
export class AiModule {}

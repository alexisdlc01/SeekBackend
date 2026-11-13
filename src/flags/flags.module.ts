import { Module } from "@nestjs/common";
import { FlagsService } from "./flags.service";
import { FlagsController } from "./flags.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Flag, FlagSchema } from "./flags.schema";
import { SharedModule } from "../shared/shared.module";
import { User, UserSchema } from "../users/users.schema";
import { AuthModule } from "../auth/auth.module";
import { Listing, ListingSchema } from "../listings/listings.schema";
import { AnthropicClient } from "../ai/anthropic.client";
import { GeminiClient } from "../ai/gemini.client";
import { LlmClient } from "../ai/llm.client";
import { NotificationsModule } from "../notifications/notifications.module";
import { Conversation, ConversationSchema } from "../conversation/converstaion.schema";
import { Tenancy, TenancySchema } from "../tenancies/tenancy.schema";
import { Message, MessageSchema } from "../conversation/message.schema";

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
			},
			{ name: Listing.name, schema: ListingSchema },
			{ name: Conversation.name, schema: ConversationSchema },
			{ name: Tenancy.name, schema: TenancySchema },
			{ name: Message.name, schema: MessageSchema }
		]),
		SharedModule,
		AuthModule,
		NotificationsModule
	],
	controllers: [FlagsController],
	providers: [FlagsService, GeminiClient, AnthropicClient, LlmClient]
})
export class FlagsModule {}

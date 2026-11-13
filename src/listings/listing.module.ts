import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "./listings.schema";
import { User, UserSchema } from "../users/users.schema";
import { Application, ApplicationSchema } from "../application/application.schema";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { SharedModule } from "../shared/shared.module";
import { AuthModule } from "../auth/auth.module";
import { ListingsGateway } from "./listings.gateway";
import UsersService from "../users/users.service";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ListingModerationService } from "./listing-moderation.service";
import { AnthropicClient } from "../ai/anthropic.client";
import { GeminiClient } from "../ai/gemini.client";
import { LlmClient } from "../ai/llm.client";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Listing.name,
				schema: ListingSchema
			},
			{ name: User.name, schema: UserSchema },
			{ name: Application.name, schema: ApplicationSchema }
		]),
		SharedModule,
		AuthModule,
		UsersModule,
		NotificationsModule
	],
	controllers: [ListingsController],
	// The AI clients are provided here, not imported: AiModule imports ListingsModule.
	providers: [ListingsService, ListingsGateway, ListingModerationService, GeminiClient, AnthropicClient, LlmClient],
	exports: [ListingsService]
})
export class ListingsModule {}

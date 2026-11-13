import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import UsersService from "./users.service";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "./users.schema";
import { SharedModule } from "../shared/shared.module";
import { PresenceService } from './presence.service';
import { RedisModule } from "../redis/redis.module";
import { PresenceGateway } from "./presence.gateway";
import { UsersRepository } from "./users.repository";
import { DocumentShare, DocumentShareSchema } from "./shares/document-share.schema";
import { DocumentSharesService } from "./shares/document-shares.service";
import { AccountService } from "./account.service";
import { StudentVerificationService } from "./student-verification.service";
import { MailService } from "../auth/mail.service";
import { Tenancy, TenancySchema } from "../tenancies/tenancy.schema";
import { Payment, PaymentSchema } from "../payments/payment.schema";
import { UploadModule } from "../upload/upload.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { DocumentReviewService } from "./document-review.service";
import { AnthropicClient } from "../ai/anthropic.client";
import { GeminiClient } from "../ai/gemini.client";
import { LlmClient } from "../ai/llm.client";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: User.name,
				schema: UserSchema
			},
			{
				name: DocumentShare.name,
				schema: DocumentShareSchema
			},
			{ name: Tenancy.name, schema: TenancySchema },
			{ name: Payment.name, schema: PaymentSchema }
		]),
		SharedModule,
		RedisModule,
		UploadModule,
		// Account deletion disconnects the user's mailboxes.
		ConnectorsModule
	],
	controllers: [UsersController],
	providers: [
		UsersService,
		PresenceGateway,
		PresenceService,
		UsersRepository,
		DocumentSharesService,
		AccountService,
		StudentVerificationService,
		// Own instance (stateless Mailgun client): AuthModule imports UsersModule, so importing it back would be circular.
		MailService,
		DocumentReviewService,
		// Own instances of the AI chain (AiModule exports nothing and imports modules that import this one).
		LlmClient,
		GeminiClient,
		AnthropicClient
	],
	exports: [UsersService, UsersRepository, DocumentSharesService]
})
export class UsersModule { }

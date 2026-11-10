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
		UploadModule
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
		MailService
	],
	exports: [UsersService, UsersRepository, DocumentSharesService]
})
export class UsersModule { }

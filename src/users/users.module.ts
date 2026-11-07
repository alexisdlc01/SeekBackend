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
import { Tenancy, TenancySchema } from "../tenancies/tenancy.schema";
import { Payment, PaymentSchema } from "../payments/payment.schema";

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
		RedisModule
	],
	controllers: [UsersController],
	providers: [
		UsersService,
		PresenceGateway,
		PresenceService,
		UsersRepository,
		DocumentSharesService,
		AccountService
	],
	exports: [UsersService, UsersRepository, DocumentSharesService]
})
export class UsersModule { }

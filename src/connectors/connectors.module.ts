import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { RedisModule } from "../redis/redis.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { UploadModule } from "../upload/upload.module";
import { Application, ApplicationSchema } from "../application/application.schema";
import { Bill, BillSchema } from "../bills/bill.schema";
import { EmailMessage, EmailMessageSchema } from "../inbox/email-message.schema";
import { EmailConnection, EmailConnectionSchema } from "./email-connection.schema";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";
import { ConnectorsSweeper } from "./connectors.sweeper";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: EmailConnection.name, schema: EmailConnectionSchema },
			{ name: EmailMessage.name, schema: EmailMessageSchema },
			{ name: Application.name, schema: ApplicationSchema },
			{ name: Bill.name, schema: BillSchema }
		]),
		SharedModule,
		RedisModule,
		TenanciesModule,
		UploadModule
	],
	controllers: [ConnectorsController],
	providers: [ConnectorsService, ConnectorsSweeper],
	exports: [ConnectorsService, MongooseModule]
})
export class ConnectorsModule {}

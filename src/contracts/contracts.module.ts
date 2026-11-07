import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Contract, ContractSchema } from "./contract.schema";
import { ContractTemplate, ContractTemplateSchema } from "./contract-template.schema";
import { Application, ApplicationSchema } from "../application/application.schema";
import { ContractsController } from "./contracts.controller";
import { ContractsService } from "./contracts.service";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Contract.name, schema: ContractSchema },
			{ name: ContractTemplate.name, schema: ContractTemplateSchema },
			{ name: Application.name, schema: ApplicationSchema }
		]),
		SharedModule,
		TenanciesModule,
		NotificationsModule
	],
	controllers: [ContractsController],
	providers: [ContractsService],
	exports: [MongooseModule]
})
export class ContractsModule {}

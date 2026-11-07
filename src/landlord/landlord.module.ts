import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { Application, ApplicationSchema } from "../application/application.schema";
import { Contract, ContractSchema } from "../contracts/contract.schema";
import { Repair, RepairSchema } from "../repairs/repair.schema";
import { LandlordController } from "./landlord.controller";
import { LandlordOverviewService } from "./landlord-overview.service";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Application.name, schema: ApplicationSchema },
			{ name: Contract.name, schema: ContractSchema },
			{ name: Repair.name, schema: RepairSchema }
		]),
		SharedModule,
		TenanciesModule
	],
	controllers: [LandlordController],
	providers: [LandlordOverviewService]
})
export class LandlordModule {}

import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { Bill, BillSchema } from "./bill.schema";
import { BillsController } from "./bills.controller";
import { BillsService } from "./bills.service";

@Module({
	imports: [
		MongooseModule.forFeature([{ name: Bill.name, schema: BillSchema }]),
		SharedModule,
		TenanciesModule
	],
	controllers: [BillsController],
	providers: [BillsService]
})
export class BillsModule {}

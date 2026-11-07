import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Repair, RepairSchema } from "./repair.schema";
import { RepairsController } from "./repairs.controller";
import { RepairsService } from "./repairs.service";

@Module({
	imports: [
		MongooseModule.forFeature([{ name: Repair.name, schema: RepairSchema }]),
		SharedModule,
		TenanciesModule,
		NotificationsModule
	],
	controllers: [RepairsController],
	providers: [RepairsService],
	exports: [MongooseModule]
})
export class RepairsModule {}

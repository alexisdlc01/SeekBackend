import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentsSweeper } from "./payments.sweeper";
import { ApplicationModule } from "../application/application.module";

@Module({
	imports: [SharedModule, TenanciesModule, NotificationsModule, ApplicationModule],
	controllers: [PaymentsController],
	providers: [PaymentsService, PaymentsSweeper]
})
export class PaymentsModule {}

import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentsSweeper } from "./payments.sweeper";
import { WeeklySummarySweeper } from "./weekly-summary.sweeper";
import { ApplicationModule } from "../application/application.module";
import { AuthModule } from "../auth/auth.module";
import { ConversationModule } from "../conversation/conversation.module";

@Module({
	imports: [SharedModule, TenanciesModule, NotificationsModule, ApplicationModule, AuthModule, ConversationModule],
	controllers: [PaymentsController],
	providers: [PaymentsService, PaymentsSweeper, WeeklySummarySweeper]
})
export class PaymentsModule {}

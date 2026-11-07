import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Listing, ListingSchema } from "../listings/listings.schema";
import { User, UserSchema } from "../users/users.schema";
import { NotificationsModule } from "../notifications/notifications.module";
import { Payment, PaymentSchema } from "../payments/payment.schema";
import { RentPlan, RentPlanSchema } from "../payments/rent-plan.schema";
import { RentScheduleService } from "../payments/rent-schedule.service";
import { Application, ApplicationSchema } from "../application/application.schema";
import { Tenancy, TenancySchema } from "./tenancy.schema";
import { TenanciesController } from "./tenancies.controller";
import { TenanciesService } from "./tenancies.service";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Tenancy.name, schema: TenancySchema },
			{ name: Listing.name, schema: ListingSchema },
			{ name: User.name, schema: UserSchema },
			{ name: RentPlan.name, schema: RentPlanSchema },
			{ name: Payment.name, schema: PaymentSchema },
			{ name: Application.name, schema: ApplicationSchema }
		]),
		SharedModule,
		NotificationsModule
	],
	controllers: [TenanciesController],
	providers: [TenanciesService, RentScheduleService],
	exports: [TenanciesService, RentScheduleService, MongooseModule]
})
export class TenanciesModule {}

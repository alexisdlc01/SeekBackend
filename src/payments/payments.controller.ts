import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Request } from "express";
import { LandlordAgency, Student } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { PaymentsService } from "./payments.service";
import {
	CheckoutConfirmQueryDto,
	CheckoutQueryDto,
	CheckoutResponseDto,
	ConnectOnboardResponseDto,
	ConnectStatusDto,
	LandlordPaymentsDto,
	LandlordPaymentsQueryDto,
	MyPaymentsQueryDto,
	PayResponseDto,
	ReminderScheduleDto,
	RemindLateDto,
	RemindLateResponseDto,
	RentPlanViewDto,
	StudentPaymentDto,
	UpdateReminderScheduleDto,
	UpdateRentPlanDto
} from "./dto/payments.dto";

@Controller("payments")
export class PaymentsController {
	constructor(private readonly paymentsService: PaymentsService) {}

	@Get("plan/:tenancyId")
	@Student()
	@ApiOperation({ summary: "The tenant's rent plan, allowed frequencies for the nation and next payments." })
	@ApiResponse({ status: 200, type: RentPlanViewDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async getPlan(@Param("tenancyId", ParseObjectIdPipe) tenancyId: string, @CurrentUser() user: User) {
		return this.paymentsService.getPlan(tenancyId, user);
	}

	@Put("plan/:tenancyId")
	@Student()
	@ApiOperation({ summary: "Change frequency, autopay or reminders. Future scheduled payments are regenerated." })
	@ApiResponse({ status: 200, type: RentPlanViewDto })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Frequency not allowed (England: monthly only)." })
	async updatePlan(
		@Param("tenancyId", ParseObjectIdPipe) tenancyId: string,
		@Body() body: UpdateRentPlanDto,
		@CurrentUser() user: User
	) {
		return this.paymentsService.updatePlan(tenancyId, body, user);
	}

	@Get("mine")
	@Student()
	@ApiOperation({ summary: "The tenant's payments, oldest due first." })
	@ApiResponse({ status: 200, type: [StudentPaymentDto] })
	async mine(@Query() query: MyPaymentsQueryDto, @CurrentUser() user: User) {
		return this.paymentsService.listMine(user._id.toString(), query.tenancy);
	}

	@TeamAccess()
	@Get("landlord")
	@LandlordAgency()
	@ApiOperation({ summary: "Rent collected, expected and late for a month, with one row per payment." })
	@ApiResponse({ status: 200, type: LandlordPaymentsDto })
	async landlord(@Query() query: LandlordPaymentsQueryDto, @CurrentUser() user: User) {
		return this.paymentsService.landlordMonth(user._id.toString(), query.month);
	}

	@TeamAccess()
	@Get("landlord/reminder-schedule")
	@LandlordAgency()
	@ApiOperation({ summary: "When Seek reminds your tenants: before the due date, on the day, three days late." })
	@ApiResponse({ status: 200, type: ReminderScheduleDto })
	async reminderSchedule(@CurrentUser() user: User) {
		return this.paymentsService.getReminderSchedule(user._id.toString());
	}

	@TeamAccess()
	@Put("landlord/reminder-schedule")
	@LandlordAgency()
	@ApiOperation({ summary: "Turn the automatic rent reminders on or off. The hourly sweep follows this setting." })
	@ApiResponse({ status: 200, type: ReminderScheduleDto })
	async updateReminderSchedule(@Body() body: UpdateReminderScheduleDto, @CurrentUser() user: User) {
		return this.paymentsService.updateReminderSchedule(user._id.toString(), body);
	}

	@TeamAccess()
	@Post("landlord/remind-late")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Remind tenants whose rent is late. One reminder per tenant per 24 hours." })
	@ApiResponse({ status: 200, type: RemindLateResponseDto })
	async remindLate(@Body() body: RemindLateDto, @CurrentUser() user: User) {
		return this.paymentsService.remindLate(user._id.toString(), body);
	}

	@TeamAccess()
	@Post("connect/onboard")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Start (or resume) Stripe payout setup. Returns the Stripe-hosted onboarding link." })
	@ApiResponse({ status: 200, type: ConnectOnboardResponseDto })
	@ApiResponse({ status: 409, type: ErrorDto, description: "Stripe Connect is not enabled on Seek's Stripe account." })
	@ApiResponse({ status: 502, type: ErrorDto, description: "Stripe rejected the request (details in the server log)." })
	@ApiResponse({ status: 503, type: ErrorDto })
	async connectOnboard(@CurrentUser() user: User) {
		return this.paymentsService.connectOnboard(user);
	}

	@TeamAccess()
	@Get("connect/status")
	@LandlordAgency()
	@ApiOperation({ summary: "Whether the landlord can take card payments and receive payouts." })
	@ApiResponse({ status: 200, type: ConnectStatusDto })
	async connectStatus(@CurrentUser() user: User) {
		return this.paymentsService.connectStatus(user._id.toString());
	}

	@Post("webhook")
	@HttpCode(200)
	@SkipThrottle()
	@ApiExcludeEndpoint()
	async webhook(
		@Req() req: Request & { rawBody?: Buffer },
		@Headers("stripe-signature") signature?: string
	) {
		return this.paymentsService.handleWebhook(req.rawBody, signature);
	}

	@Post(":id/checkout")
	@Student()
	@HttpCode(200)
	@ApiOperation({
		summary: "Pay with Stripe's hosted Checkout page. Returns its url; Seek's 1% fee goes to Seek, the rest to the landlord's connected account."
	})
	@ApiResponse({ status: 200, type: CheckoutResponseDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 503, type: ErrorDto })
	async checkout(
		@Param("id", ParseObjectIdPipe) id: string,
		@Query() query: CheckoutQueryDto,
		@CurrentUser() user: User,
		@Headers("platform") platform?: string
	) {
		return this.paymentsService.checkout(id, user, query, platform);
	}

	@Get(":id/checkout/confirm")
	@Student()
	@ApiOperation({ summary: "Called after Stripe redirects back: marks the payment paid and saves the card for autopay." })
	@ApiResponse({ status: 200, type: PayResponseDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async confirmCheckout(
		@Param("id", ParseObjectIdPipe) id: string,
		@Query() query: CheckoutConfirmQueryDto,
		@CurrentUser() user: User
	) {
		return this.paymentsService.confirmCheckout(id, query.session_id, user);
	}

	@TeamAccess()
	@Post(":id/remind")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Remind one tenant about one unpaid payment. One reminder per 24 hours." })
	@ApiResponse({ status: 200, type: RemindLateResponseDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async remind(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.paymentsService.remindOne(user._id.toString(), id);
	}

	@Post(":id/pay")
	@Student()
	@HttpCode(200)
	@ApiOperation({
		summary: "Pay one instalment. Returns a Stripe client secret, or PAID straight away in local simulated mode."
	})
	@ApiResponse({ status: 200, type: PayResponseDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 503, type: ErrorDto })
	async pay(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.paymentsService.pay(id, user);
	}
}

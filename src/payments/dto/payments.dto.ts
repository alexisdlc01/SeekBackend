import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { PaymentKind, PaymentProvider, PaymentStatus, PayoutStatus, PlanFrequency } from "../payment.enums";
import { Payment } from "../payment.schema";
import { RentPlan } from "../rent-plan.schema";

/** A payment as the tenant sees it: without Seek's fee or the landlord's payout. */
export class StudentPaymentDto extends OmitType(Payment, ["seekFee", "payout"] as const) {}

export class RentPlanViewDto {
	@ApiProperty({ description: "False until the tenant saves a plan; plan then holds the defaults." })
	exists: boolean;

	@ApiProperty({ type: RentPlan })
	plan: RentPlan;

	@ApiProperty({ description: "Rent per tenant per month, in pence." })
	monthlyRent: number;

	@ApiProperty({ example: "ENGLAND" })
	nation: string;

	@ApiProperty({ enum: PlanFrequency, isArray: true, description: "England: MONTHLY only." })
	allowedFrequencies: PlanFrequency[];

	@ApiProperty({ type: String, nullable: true, description: "Why other frequencies are not offered." })
	restrictionReason: string | null;

	@ApiProperty({ enum: ["stripe", "simulated", "unavailable"] })
	mode: "stripe" | "simulated" | "unavailable";

	@ApiProperty({ description: "True once a card is saved for autopay (Stripe charges it off-session)." })
	autopayCardSaved: boolean;

	@ApiProperty({ type: [StudentPaymentDto], description: "Next payments due (up to 3)." })
	upcoming: StudentPaymentDto[];
}

export class UpdateRentPlanDto {
	@ApiProperty({ enum: PlanFrequency })
	@IsEnum(PlanFrequency)
	frequency: PlanFrequency;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	autopay?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	notifyEveryPayment?: boolean;

	@ApiPropertyOptional({ minimum: 0, maximum: 14 })
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(14)
	remindDaysBefore?: number;
}

export class MyPaymentsQueryDto {
	@ApiPropertyOptional({ description: "Only payments for this tenancy." })
	@IsOptional()
	@IsMongoId()
	tenancy?: string;
}

export class LandlordPaymentsQueryDto {
	@ApiPropertyOptional({ example: "2026-11", description: "Defaults to the current month (UTC)." })
	@IsOptional()
	@Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "month must look like YYYY-MM" })
	month?: string;
}

export class PayResponseDto {
	@ApiProperty()
	paymentId: string;

	@ApiProperty({ enum: PaymentStatus })
	status: PaymentStatus;

	@ApiProperty({ enum: PaymentProvider })
	provider: PaymentProvider;

	@ApiProperty({
		nullable: true,
		type: String,
		description: "Stripe PaymentIntent client secret for the Payment Element. Null when already paid or simulated."
	})
	clientSecret: string | null;
}

// Syntax only; PaymentsService.assertReturnUrl decides which origins are allowed.
const REDIRECT_URL = /^(https?|seekapp|seek|exps?):\/\/\S+$/;

export class CheckoutQueryDto {
	@ApiPropertyOptional({
		description: "Where Stripe sends the payer after paying. {CHECKOUT_SESSION_ID} is replaced by Stripe. Must be on the web app (FRONTEND_URL) or the app scheme (seekapp://, seek://); outside production also http://localhost:* and Expo Go (exp://, exps://). Defaults to the web app, or seekapp:// on mobile."
	})
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	@Matches(REDIRECT_URL, { message: "successUrl must be an http(s), seekapp:// or exp:// URL" })
	successUrl?: string;

	@ApiPropertyOptional({ description: "Where Stripe sends the payer if they go back." })
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	@Matches(REDIRECT_URL, { message: "cancelUrl must be an http(s), seekapp:// or exp:// URL" })
	cancelUrl?: string;
}

export class CheckoutConfirmQueryDto {
	@ApiProperty({ description: "The Checkout Session id from the success URL." })
	@IsString()
	@Matches(/^cs_[A-Za-z0-9_]+$/, { message: "session_id must be a Stripe Checkout Session id" })
	session_id: string;
}

export class CheckoutResponseDto {
	@ApiProperty({ enum: ["stripe", "simulated"] })
	mode: "stripe" | "simulated";

	@ApiProperty({ type: String, nullable: true, description: "Checkout Session id. Null in simulated mode." })
	sessionId: string | null;

	@ApiProperty({
		type: String,
		nullable: true,
		description: "Open this page. Stripe's hosted Checkout, or the success URL straight away in simulated mode (already paid). Null when the payment was already paid: nothing to open."
	})
	url: string | null;

	@ApiProperty({ enum: PaymentStatus })
	status: PaymentStatus;
}

export class PayoutBankDto {
	@ApiProperty({ type: String, nullable: true })
	last4: string | null;

	@ApiProperty({ type: String, nullable: true })
	bankName: string | null;

	@ApiProperty({ description: "Stripe has verified the account." })
	verified: boolean;
}

export class ReminderScheduleDto {
	@ApiProperty({ description: "Remind before the due date (each tenant's own lead time, 3 days by default)." })
	@IsBoolean()
	beforeDue: boolean;

	@ApiProperty({ description: "Remind on the day rent is due." })
	@IsBoolean()
	onDueDay: boolean;

	@ApiProperty({ description: "Remind once, three days after the due date, if it is still unpaid." })
	@IsBoolean()
	lateAfterThreeDays: boolean;
}

export class UpdateReminderScheduleDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	beforeDue?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	onDueDay?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	lateAfterThreeDays?: boolean;
}

export class RemindLateDto {
	@ApiPropertyOptional({ type: [String], description: "Only these late payments. Omit to remind every late tenant." })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(200)
	@IsMongoId({ each: true })
	payments?: string[];
}

export class RemindLateResponseDto {
	@ApiProperty({ description: "Tenants reminded just now." })
	reminded: number;

	@ApiProperty({ description: "Late payments skipped because the tenant was already reminded in the last 24 hours." })
	skipped: number;
}

export class ConnectOnboardResponseDto {
	@ApiProperty({ enum: ["stripe", "simulated"] })
	mode: "stripe" | "simulated";

	@ApiProperty()
	accountId: string;

	@ApiProperty({
		type: String,
		nullable: true,
		description: "Stripe-hosted onboarding page to open. Null in simulated mode, where the account is ready straight away."
	})
	url: string | null;
}

export class ConnectStatusDto {
	@ApiProperty({ enum: ["stripe", "simulated", "unavailable"] })
	mode: "stripe" | "simulated" | "unavailable";

	@ApiProperty({ description: "A payout account has been created for this landlord." })
	connected: boolean;

	@ApiProperty({ type: String, nullable: true })
	accountId: string | null;

	@ApiProperty({ description: "Tenants can pay by card." })
	chargesEnabled: boolean;

	@ApiProperty({ description: "Stripe can pay out to the landlord's bank." })
	payoutsEnabled: boolean;

	@ApiProperty({ description: "The landlord finished Stripe's onboarding form." })
	detailsSubmitted: boolean;

	@ApiProperty({ type: PayoutBankDto, nullable: true, description: "Where payouts go. Null until a bank account is added." })
	payoutBank: PayoutBankDto | null;
}

export class LandlordPaymentRowDto {
	@ApiProperty()
	payment: string;

	@ApiProperty({ enum: PaymentKind })
	kind: PaymentKind;

	@ApiProperty({ type: String, nullable: true, description: "Null for a holding deposit." })
	tenancy: string | null;

	@ApiProperty({ nullable: true, type: String })
	property: string | null;

	@ApiProperty()
	tenant: { _id: string; name?: string };

	@ApiProperty()
	amount: number;

	@ApiProperty({ enum: PaymentStatus })
	status: PaymentStatus;

	@ApiProperty({ type: String, format: "date-time" })
	dueDate: Date;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	paidAt: Date | null;

	@ApiProperty({ enum: PlanFrequency, nullable: true, description: "How often this tenant pays. Null for a holding deposit." })
	plan: PlanFrequency | null;

	@ApiProperty({ description: "Paid automatically with a saved card." })
	autopay: boolean;

	@ApiProperty({ minimum: 0, maximum: 14 })
	remindDaysBefore: number;

	@ApiProperty({ description: "Reminders Seek has sent this tenant for this payment." })
	remindersSent: number;

	@ApiProperty({ description: "A paid holding deposit the landlord must refund within 7 days (Tenant Fees Act)." })
	refundDue: boolean;

	@ApiProperty({ description: "Seek's 1% fee on this payment, pence." })
	fee: number;

	@ApiProperty({ description: "What the landlord receives for this payment, pence." })
	payout: number;

	@ApiProperty({ description: "The tenant's paid holding deposit counted toward this rent, pence (0 if none). `amount` is already reduced by it." })
	holdingDepositCredit: number;

	@ApiProperty({
		type: String,
		format: "date-time",
		nullable: true,
		description: "Estimated payout date for this payment: two working days after it is paid or due. Null once it is late or failed, or while it is held."
	})
	nextPayout: Date | null;

	@ApiProperty({ enum: PayoutStatus, nullable: true, description: "HELD: Seek holds this payment until payouts are set up. TRANSFERRED: released since." })
	payoutStatus: PayoutStatus | null;
}

export class LandlordPaymentsDto {
	@ApiProperty({ example: "2026-11" })
	month: string;

	@ApiProperty({ description: "Rent paid this month, pence. Holding deposits are in holdingDepositsCollected. Same figure as /landlord/overview rentCollectedThisMonth." })
	collected: number;

	@ApiProperty({ description: "Rent due this month, pence (holding deposits excluded)." })
	expected: number;

	@ApiProperty({ description: "Number of late rent payments this month." })
	late: number;

	@ApiProperty({ description: "Late rent amount this month, pence." })
	lateAmount: number;

	@ApiProperty({ description: "Holding deposits paid this month, pence. Not rent: the landlord keeps them in full." })
	holdingDepositsCollected: number;

	@ApiProperty({ description: "Holding deposits due this month, pence." })
	holdingDepositsExpected: number;

	@ApiProperty({ description: "Seek fees on payments collected this month, pence." })
	seekFee: number;

	@ApiProperty({ description: "Paid out to the landlord this month, pence." })
	payouts: number;

	@ApiProperty({
		type: String,
		format: "date-time",
		nullable: true,
		description: "Estimated date of the next payout: two working days after the earliest paid or due rent. Null when nothing is on its way, or while payouts are on hold."
	})
	nextPayoutDate: Date | null;

	@ApiProperty({ description: "True when card payments can't reach the landlord yet (no Stripe payout account able to take them): Seek holds them until payouts are set up." })
	payoutsOnHold: boolean;

	@ApiProperty({ description: "Paid this month but held by Seek until payouts are set up, pence (after Seek's fee)." })
	held: number;

	@ApiProperty({ type: [LandlordPaymentRowDto] })
	rows: LandlordPaymentRowDto[];
}

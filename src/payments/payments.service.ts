import { createHash } from "node:crypto";
import {
	BadRequestException,
	BadGatewayException,
	ConflictException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Payment } from "./payment.schema";
import { RentPlan } from "./rent-plan.schema";
import { PaymentKind, PaymentProvider, PaymentStatus, PayoutStatus, PlanFrequency } from "./payment.enums";
import { allowedFrequencies, assertPlanAllowed, estimateNextPayout, feeFor, restrictionReason, startOfUtcDay } from "./schedule";
import { dueReminderStage, normaliseReminderSchedule, ReminderSchedule } from "./reminders";
import { RentScheduleService } from "./rent-schedule.service";
import {
	StripeAccount,
	StripeApiError,
	StripeCheckoutSession,
	StripeClient,
	StripePaymentIntent,
	verifyStripeSignature
} from "./stripe";

/** Stripe error codes that really mean "Seek's Connect platform setup isn't finished". */
const CONNECT_NOT_ENABLED = new Set([
	"platform_registration_required",
	"non_connect_platform_accounts_v2_access_blocked",
	"connect_profile_not_submitted",
	"connect_identity_not_verified",
	"account_creation_losses_collector_unavailable",
	"account_creation_liability_unacknowledged",
	"account_creation_liability_unacknowledged_and_identity_verification_incomplete"
]);

/**
 * Card payments are direct charges on the landlord's own connected account, so Seek never
 * holds tenant money: the account needs the merchant `card_payments` capability.
 */
const canCharge = (account: StripeAccount) => account.capabilities?.card_payments === "active";
/** Releasing a legacy held payment is a transfer: that needs `transfers` (v2 recipient `stripe_transfers`). */
const canTransfer = (account: StripeAccount) => account.capabilities?.transfers === "active";
/**
 * Stripe's "No such account" (404, including "a similar object exists in test mode"). Not a 403: that can be a
 * restricted key missing a permission, and must never make Seek forget or replace a landlord's account.
 */
const isGoneAccount = (error: unknown): error is StripeApiError => error instanceof StripeApiError && error.status === 404;
/**
 * Reads or closes an earlier session/intent; null when Stripe answers 404 (it, or the connected account the landlord
 * replaced, is gone), so it counts as dead instead of blocking the row. A 403 (Seek lost access to an account that may
 * still exist, where the student could still pay) is dead only when `lostIsDead` says it can no longer be paid; never for
 * an intent, whose client secret may still confirm it. 429/5xx rethrow.
 */
async function unlessGone<T>(call: Promise<T>, lostIsDead = false): Promise<T | null> {
	try {
		return await call;
	} catch (error) {
		if (error instanceof StripeApiError && (error.status === 404 || (error.status === 403 && lostIsDead))) return null;
		throw error;
	}
}
/**
 * A hosted Checkout page can be paid for at most 24 hours after it was created. Writing providerRef = session.id bumps
 * the row's updatedAt (timestamps), so updatedAt older than that means the stored session can no longer be paid.
 */
const checkoutLapsed = (payment: object) => {
	const at = (payment as { updatedAt?: Date }).updatedAt;
	return Boolean(at) && Date.now() - new Date(at!).getTime() > 24 * 3_600_000;
};

const CARD_NOT_READY = "Your landlord hasn't finished setting up card payments on Seek yet, so this can't be paid by card. Use the bank transfer details or ask them to finish setup.";
import {
	CheckoutQueryDto,
	CheckoutResponseDto,
	ConnectOnboardResponseDto,
	ConnectStatusDto,
	LandlordPaymentsDto,
	RemindLateDto,
	RemindLateResponseDto,
	UpdateRentPlanDto,
	UpdateReminderScheduleDto
} from "./dto/payments.dto";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { earliestNoticeEnd, londonCalendarDay, TenanciesService } from "../tenancies/tenancies.service";
import { hasFixedTerms } from "./schedule";
import { Nation } from "../listings/enums/nation.enum";
import { listingCompliance, tenancyCompliance } from "../tenancies/compliance";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";
import { MailService } from "../auth/mail.service";
import { ConversationService } from "../conversation/conversation.service";
import { notifyHoldingRefund, proportionalRefund, refundPayment, refundStripeCharge } from "./refund";

type Viewer = Pick<User, "_id" | "role">;
type PaymentLean = Payment & { _id: Types.ObjectId };

const PAYABLE = [PaymentStatus.SCHEDULED, PaymentStatus.LATE, PaymentStatus.FAILED];
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_INTENT_STATUSES = [
	"requires_payment_method",
	"requires_confirmation",
	"requires_action",
	"processing"
];

export function formatPence(pence: number): string {
	return `£${(pence / 100).toFixed(2)}`;
}

function formatDay(date: Date): string {
	return new Date(date).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		timeZone: "Europe/London"
	});
}

export function monthRange(month?: string, now: Date = new Date()) {
	const [year, monthIndex] = month
		? month.split("-").map(Number)
		: [now.getUTCFullYear(), now.getUTCMonth() + 1];
	const start = new Date(Date.UTC(year, monthIndex - 1, 1));
	const end = new Date(Date.UTC(year, monthIndex, 1));
	return { start, end, label: `${year}-${String(monthIndex).padStart(2, "0")}` };
}

/** Seek's commission on a direct charge, taken from the landlord's side (none on holding deposits). */
function seekFeeParams(seekFee: number) {
	return seekFee > 0 ? { application_fee_amount: seekFee } : {};
}

function assertRentOpen(status: TenancyStatus | string) {
	if (status !== TenancyStatus.ACTIVE) {
		throw new BadRequestException(
			status === TenancyStatus.PENDING_ACCEPTANCE
				? "Rent starts once every housemate has accepted the tenancy."
				: "This tenancy has ended."
		);
	}
}

/** A rolling tenancy only gets an end date from notice; regenerating then would bill the last partial month in full. */
function assertPlanCanChange(tenancy: { endDate?: Date | null; periodic?: boolean; noticeGivenAt?: Date | null }, from: PlanFrequency | undefined, to: PlanFrequency) {
	if (tenancy.endDate && (tenancy.periodic || tenancy.noticeGivenAt) && (from ?? PlanFrequency.MONTHLY) !== to) {
		throw new BadRequestException("Your tenancy is ending: the rent plan can no longer change.");
	}
}

/** Students never see Seek's fee or the landlord's payout. */
function forTenant<T extends { seekFee?: number; payout?: number }>({ seekFee, payout, ...rest }: T) {
	return rest;
}

@Injectable()
export class PaymentsService {
	private readonly logger = new Logger(PaymentsService.name);

	constructor(
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(RentPlan.name) private readonly planModel: Model<RentPlan>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly tenancies: TenanciesService,
		private readonly rentSchedule: RentScheduleService,
		private readonly notifications: NotificationsService,
		private readonly config: ConfigService,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		private readonly mail?: MailService,
		private readonly conversations?: ConversationService
	) {}

	/** A holding deposit is payable only while its offer is open. Returns when that offer lapses. */
	private async assertHoldingPayable(payment: PaymentLean, now: Date = new Date()): Promise<Date | null> {
		if (payment.kind !== PaymentKind.HOLDING_DEPOSIT) return null;
		const application = await this.applicationModel
			.findById(payment.application, { stage: 1, offerExpiresAt: 1, listing: 1 })
			.lean()
			.exec();
		const expires = application?.offerExpiresAt ? new Date(application.offerExpiresAt) : null;
		if (application?.stage !== ApplicationStage.OFFERED || !expires || expires <= now) {
			throw new BadRequestException("This offer is no longer open, so its holding deposit can't be paid.");
		}
		// A deleted or suspended landlord gets no payout, so a deposit paid now would be stuck with Seek.
		const landlord = await this.userModel.findById(payment.landlord, { suspendedAt: 1, deletedAt: 1 }).lean().exec();
		if (!landlord || landlord.suspendedAt || landlord.deletedAt) {
			throw new BadRequestException("This landlord is no longer on Seek, so this holding deposit can't be paid.");
		}
		await this.tenancies.assertNoCurrentTenancy([payment.tenant], application.listing);
		return expires;
	}

	/**
	 * stripe: STRIPE_SECRET_KEY is set. simulated: no key under NODE_ENV
	 * development or test, so the flows can be exercised locally. unavailable:
	 * no key anywhere else, NODE_ENV unset included (fails closed: start:prod sets none).
	 */
	mode(): "stripe" | "simulated" | "unavailable" {
		if (this.config.get<string>("STRIPE_SECRET_KEY")) return "stripe";
		return ["development", "test"].includes(this.config.get<string>("NODE_ENV") ?? "") ? "simulated" : "unavailable";
	}

	async getPlan(tenancyId: string, tenant: Viewer) {
		const tenancy = await this.tenancies.findForTenant(tenancyId, tenant);
		const listing = await this.listingModel.findById(tenancy.listing, { nation: 1, paymentPlans: 1 }).lean().exec();
		const plan = await this.planModel
			.findOne({ tenancy: tenancy._id, tenant: tenant._id })
			.lean()
			.exec();
		const upcoming = await this.upcoming(tenancy._id, tenant._id);
		return {
			exists: Boolean(plan),
			plan: plan ?? {
				tenancy: tenancy._id,
				tenant: tenant._id,
				frequency: PlanFrequency.MONTHLY,
				autopay: false,
				notifyEveryPayment: true,
				remindDaysBefore: 3
			},
			monthlyRent: tenancy.monthlyRent,
			bankTransferInstructions: tenancy.bankTransferInstructions,
			nation: listing?.nation ?? "ENGLAND",
			allowedFrequencies: allowedFrequencies(listing?.nation, listing?.paymentPlans ?? null),
			restrictionReason: restrictionReason(listing?.nation),
			mode: this.mode(),
			// Same card condition sweepStripeAutopay charges on; the id itself stays server-side.
			autopayCardSaved: plan ? Boolean(await this.planModel.exists({ _id: plan._id, paymentMethodId: { $nin: [null, ""] } })) : false,
			upcoming: upcoming.map(forTenant)
		};
	}

	/** Next payments due (up to 3), as the plan screen lists them. */
	private upcoming(tenancy: Types.ObjectId, tenant: Types.ObjectId | string, extra: Record<string, unknown> = {}) {
		return this.paymentModel
			.find({
				tenancy,
				tenant,
				status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.LATE, PaymentStatus.FAILED, PaymentStatus.PENDING] },
				...extra
			})
			.sort({ dueDate: 1 })
			.limit(3)
			.lean()
			.exec();
	}

	private hasFutureRent(tenancy: Types.ObjectId, tenant: Types.ObjectId) {
		return this.paymentModel.exists({ tenancy, tenant, status: PaymentStatus.SCHEDULED, dueDate: { $gte: startOfUtcDay(new Date()) } });
	}

	/**
	 * The next payments (up to 3) as they would stand after updatePlan with this
	 * frequency. Read-only: same checks as updatePlan, same schedule code as regenerate.
	 */
	async previewPlan(tenancyId: string, frequency: PlanFrequency, tenant: Viewer) {
		const tenancy = await this.tenancies.findForTenant(tenancyId, tenant);
		assertRentOpen(tenancy.status);
		const before = await this.planModel.findOne({ tenancy: tenancy._id, tenant: tenant._id }).lean().exec();
		assertPlanCanChange(tenancy, before?.frequency, frequency);
		if (before?.frequency !== frequency) {
			const listing = await this.listingModel.findById(tenancy.listing, { nation: 1, paymentPlans: 1 }).lean().exec();
			assertPlanAllowed(listing?.nation, frequency, listing?.paymentPlans ?? null);
		}
		const tenantId = new Types.ObjectId(tenant._id.toString());
		const show = (rows: { dueDate: Date; amount: number; coversMonths?: number; holdingDepositCredit?: number; status: PaymentStatus }[]) =>
			rows.map(({ dueDate, amount, coversMonths, holdingDepositCredit, status }) => ({ dueDate, amount, coversMonths: coversMonths ?? 1, holdingDepositCredit: holdingDepositCredit ?? 0, status }));
		// Same condition as updatePlan: an unchanged plan keeps its schedule.
		if (before?.frequency === frequency && (await this.hasFutureRent(tenancy._id, tenantId))) {
			return show(await this.upcoming(tenancy._id, tenantId));
		}
		const { replaced, added } = await this.rentSchedule.preview(tenancy, tenantId, frequency);
		const kept = await this.upcoming(tenancy._id, tenantId, { $nor: [replaced] });
		return show([...kept, ...added].sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()).slice(0, 3));
	}

	async updatePlan(tenancyId: string, dto: UpdateRentPlanDto, tenant: Viewer) {
		const tenancy = await this.tenancies.findForTenant(tenancyId, tenant);
		assertRentOpen(tenancy.status);
		const before = await this.planModel
			.findOne({ tenancy: tenancy._id, tenant: tenant._id })
			.lean()
			.exec();
		assertPlanCanChange(tenancy, before?.frequency, dto.frequency);
		// A frequency the listing later stopped offering must not block the tenant's other settings.
		if (before?.frequency !== dto.frequency) {
			const listing = await this.listingModel.findById(tenancy.listing, { nation: 1, paymentPlans: 1 }).lean().exec();
			assertPlanAllowed(listing?.nation, dto.frequency, listing?.paymentPlans ?? null);
		}
		const set: Partial<RentPlan> = { frequency: dto.frequency };
		if (dto.autopay !== undefined) set.autopay = dto.autopay;
		if (dto.notifyEveryPayment !== undefined) set.notifyEveryPayment = dto.notifyEveryPayment;
		if (dto.remindDaysBefore !== undefined) {
			set.remindDaysBefore = dto.remindDaysBefore;
			// The reminder job reads the account-wide preference; keep it in step.
			await this.userModel.updateOne(
				{ _id: tenant._id },
				{ $set: { "notificationPrefs.rentReminderDaysBefore": dto.remindDaysBefore } }
			);
		}
		await this.planModel.updateOne(
			{ tenancy: tenancy._id, tenant: tenant._id },
			{ $set: set, $setOnInsert: { tenancy: tenancy._id, tenant: tenant._id } },
			{ upsert: true }
		);
		const tenantId = new Types.ObjectId(tenant._id.toString());
		const hasFuture = await this.hasFutureRent(tenancy._id, tenantId);
		if (!before || before.frequency !== dto.frequency || !hasFuture) {
			await this.rentSchedule.regenerate(tenancy, tenantId, dto.frequency);
		}
		return this.getPlan(tenancyId, tenant);
	}

	async listMine(tenantId: string, tenancyId?: string) {
		const filter: Record<string, unknown> = { tenant: new Types.ObjectId(tenantId) };
		if (tenancyId) filter.tenancy = new Types.ObjectId(tenancyId);
		const payments = await this.paymentModel
			.find(filter)
			.populate({
				path: "tenancy",
				select: "listing",
				populate: { path: "listing", select: "propertyTitle streetAddress cityTown" }
			})
			// A holding deposit has no tenancy: its property comes from the application's listing.
			.populate({
				path: "application",
				select: "listing",
				populate: { path: "listing", select: "propertyTitle streetAddress cityTown" }
			})
			.sort({ dueDate: 1 })
			.lean()
			.exec();
		return payments.map(forTenant);
	}

	async pay(paymentId: string, tenant: Viewer) {
		const payment = await this.findPayment(paymentId);
		if (payment.tenant.toString() !== tenant._id.toString()) {
			throw new ForbiddenException("You can only pay your own rent.");
		}
		if (payment.status === PaymentStatus.PAID) {
			return this.payResponse(payment, null);
		}
		await this.assertHoldingPayable(payment);

		const mode = this.mode();
		if (mode === "unavailable") {
			throw new ServiceUnavailableException("Card payments are not available right now. Please try again later.");
		}
		if (mode === "simulated") {
			if (!PAYABLE.includes(payment.status) && payment.status !== PaymentStatus.PENDING) {
				throw new BadRequestException("This payment cannot be paid.");
			}
			const paid = await this.markPaid(payment, PaymentProvider.SIMULATED, `sim_${payment._id.toString()}`);
			return this.payResponse(paid ?? payment, null);
		}
		return this.payWithStripe(payment);
	}

	async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
		// Platform endpoint (legacy charges) and Connect endpoint (direct charges on landlords' accounts).
		const secrets = [this.config.get<string>("STRIPE_WEBHOOK_SECRET"), this.config.get<string>("STRIPE_CONNECT_WEBHOOK_SECRET")]
			.filter((secret): secret is string => Boolean(secret));
		if (secrets.length === 0) {
			throw new ServiceUnavailableException("Stripe webhooks are not configured.");
		}
		if (!rawBody || !secrets.some(secret => verifyStripeSignature({ payload: rawBody, header: signature, secret }))) {
			throw new BadRequestException("Invalid Stripe signature.");
		}

		let event: { type?: string; account?: string; data?: { object?: StripePaymentIntent } };
		try {
			event = JSON.parse(rawBody.toString("utf8"));
		} catch {
			throw new BadRequestException("Invalid webhook payload.");
		}
		// The connected account the event happened on; none for Seek's own (legacy) charges.
		const account = event.account ?? null;
		if (event.type === "checkout.session.completed") {
			const sessionId = event.data?.object?.id;
			// The event's payment_intent is a bare id: the retrieved session expands it, so the autopay card gets saved.
			if (sessionId && this.mode() === "stripe") {
				await this.completeCheckout(
					await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!, account ?? undefined).retrieveCheckoutSession(sessionId),
					account
				);
			}
			return { received: true };
		}
		const intent = event.data?.object;
		if (!intent?.id || !event.type?.startsWith("payment_intent.")) {
			return { received: true };
		}

		const payment = await this.paymentModel
			.findOne({
				$or: [
					{ providerRef: intent.id },
					...(intent.metadata?.paymentId && Types.ObjectId.isValid(intent.metadata.paymentId)
						? [{ _id: new Types.ObjectId(intent.metadata.paymentId) }]
						: [])
				]
			})
			.lean()
			.exec();
		if (!payment) {
			this.logger.warn(`Stripe event ${event.type} for unknown intent ${intent.id}`);
			return { received: true };
		}
		// A charge on any other account than the one Seek opened it on never settles this payment.
		if ((payment.stripeAccountId ?? null) !== account) {
			this.logger.warn(`Stripe event ${event.type} for payment ${payment._id.toString()} came from account ${account ?? "platform"}, expected ${payment.stripeAccountId ?? "platform"}: ignored`);
			// Money taken there (a legacy intent outliving its row's move, say) is never kept: it goes back to the payer.
			if (event.type === "payment_intent.succeeded") await this.refundCharge(intent.id, "duplicate", account);
			return { received: true };
		}
		if (typeof intent.amount === "number" && intent.amount !== payment.amount) {
			this.logger.error(`Stripe amount mismatch for payment ${payment._id.toString()}: charged ${intent.amount}, expected ${payment.amount}`);
			// A captured charge Seek can't match is never kept silently: it goes back to the payer.
			if (event.type === "payment_intent.succeeded") await this.refundCharge(intent.id, "requested_by_customer", account);
			return { received: true };
		}

		if (event.type === "payment_intent.succeeded") {
			const paid = await this.markPaid(payment as PaymentLean, PaymentProvider.STRIPE, intent.id);
			if (!paid) await this.refundIfDuplicate(payment._id, intent.id, account);
		} else if (event.type === "payment_intent.payment_failed") {
			// A declined card on Checkout is retried on the same page: its session stays the reference.
			if (payment.providerRef?.startsWith("cs_")) return { received: true };
			const failed = await this.paymentModel.updateOne(
				{ _id: payment._id, status: PaymentStatus.PENDING, providerRef: intent.id },
				{ $set: { status: PaymentStatus.FAILED, provider: PaymentProvider.STRIPE } }
			);
			if (failed.modifiedCount > 0) {
				await this.notifications.notify({
					user: payment.tenant,
					kind: NotificationKind.PAYMENT_FAILED,
					title: `Your rent payment of ${formatPence(payment.amount)} didn't go through`,
					body: "Try again with another card.",
					...notificationTarget("student", NotificationTargetKind.PAYMENTS)
				});
			}
		}
		return { received: true };
	}

	async landlordMonth(landlordId: string, month?: string): Promise<LandlordPaymentsDto> {
		const range = monthRange(month);
		const landlord = new Types.ObjectId(landlordId);
		const load = (filter: Record<string, unknown>) => this.paymentModel
			.find({ landlord, ...filter })
			.populate({
				path: "tenancy",
				select: "listing",
				populate: { path: "listing", select: "propertyTitle streetAddress" }
			})
			// A holding deposit has no tenancy yet: its property comes from the application's listing.
			.populate({
				path: "application",
				select: "listing",
				populate: { path: "listing", select: "propertyTitle streetAddress" }
			})
			.populate({ path: "tenant", select: "name profilePicUrl" })
			.sort({ dueDate: 1 })
			.lean()
			.exec();
		const payments = await load({ dueDate: { $gte: range.start, $lt: range.end } });
		// This month also shows older arrears, as /landlord/overview counts them: late only, never expected or collected.
		const arrears = range.label === monthRange(undefined, londonCalendarDay()).label
			? await load({ kind: { $ne: PaymentKind.HOLDING_DEPOSIT }, status: PaymentStatus.LATE, dueDate: { $lt: range.start } })
			: [];
		const olderLate = new Set(arrears.map(payment => payment._id.toString()));
		payments.push(...arrears);

		const plans = await this.planModel
			.find({ tenancy: { $in: payments.map(p => (p.tenancy as unknown as { _id: Types.ObjectId })?._id ?? p.tenancy) } })
			.lean()
			.exec();
		const planFor = new Map(plans.map(plan => [`${plan.tenancy.toString()}:${plan.tenant.toString()}`, plan]));

		const { onHold: payoutsOnHold, paused: payoutsPaused } = await this.payoutState(landlordId);
		const totals = { collected: 0, expected: 0, late: 0, lateAmount: 0, seekFee: 0, payouts: 0, held: 0, holdingDepositsCollected: 0, holdingDepositsExpected: 0 };
		const rows = payments.map(payment => {
			// Rent totals match /landlord/overview; holding deposits are counted on their own.
			const isHolding = payment.kind === PaymentKind.HOLDING_DEPOSIT;
			const paid = payment.status === PaymentStatus.PAID;
			if (isHolding) {
				totals.holdingDepositsExpected += payment.amount;
				// A refunded deposit went back to the student: it stays PAID with refundedAt set.
				if (paid && !payment.refundedAt) totals.holdingDepositsCollected += payment.amount;
			} else if (payment.status !== PaymentStatus.CANCELLED && !olderLate.has(payment._id.toString())) {
				// Rent cancelled by an early tenancy end is no longer owed.
				totals.expected += payment.amount;
				if (paid) totals.collected += payment.amount;
			}
			const held = payment.payoutStatus === PayoutStatus.HELD;
			// A refund also gives back Seek's fee and the payout pro rata (refund_application_fee + transfer reversal).
			const kept = paid && payment.refundedAt ? proportionalRefund(payment.amount, payment.refundedAmount ?? payment.amount, payment.seekFee) : null;
			if (paid) {
				const payout = kept ? kept.landlordNet : payment.payout;
				totals.seekFee += kept ? kept.keptSeekFee : payment.seekFee;
				if (held) totals.held += payout;
				else totals.payouts += payout;
			}
			if (payment.status === PaymentStatus.LATE && !isHolding) {
				totals.late += 1;
				totals.lateAmount += payment.amount;
			}
			const tenancy = payment.tenancy as unknown as { _id: Types.ObjectId; listing?: Listing } | null;
			const tenantDoc = payment.tenant as unknown as { _id: Types.ObjectId; name?: string };
			const plan = planFor.get(`${tenancy?._id?.toString()}:${tenantDoc?._id?.toString()}`);
			const listing = tenancy?.listing ?? (payment.application as unknown as { listing?: Listing } | null)?.listing;
			const holding = payment.kind === PaymentKind.HOLDING_DEPOSIT;
			const open = payment.status === PaymentStatus.SCHEDULED || payment.status === PaymentStatus.PENDING;
			// Refunded rows show what was kept (as the totals do); cancelled rows cost nothing.
			const money = kept
				? { seekFee: kept.keptSeekFee, payout: kept.landlordNet }
				: payment.status === PaymentStatus.CANCELLED ? { seekFee: 0, payout: 0 } : feeFor(payment);
			return {
				payment: payment._id.toString(),
				kind: payment.kind ?? PaymentKind.RENT,
				tenancy: tenancy?._id?.toString() ?? (payment.tenancy ? String(payment.tenancy) : null),
				property: listing?.propertyTitle ?? listing?.streetAddress ?? null,
				listing: listing?._id ? String(listing._id) : null,
				tenant: { _id: tenantDoc?._id?.toString() ?? String(payment.tenant), name: tenantDoc?.name },
				amount: payment.amount,
				status: payment.status,
				dueDate: payment.dueDate,
				paidAt: payment.paidAt,
				// A one-off holding deposit has no rent plan.
				plan: holding ? null : (plan?.frequency ?? PlanFrequency.MONTHLY),
				autopay: holding ? false : (plan?.autopay ?? false),
				remindDaysBefore: plan?.remindDaysBefore ?? 3,
				remindersSent: payment.remindersSent ?? 0,
				// The stored flag stays set so a late payment of a cancelled row still auto-refunds; only paid money is shown as owed back.
				refundDue: payment.status === PaymentStatus.PAID && !payment.refundedAt && (payment.refundDue ?? false),
				refundedAt: payment.refundedAt ?? null,
				refundedAmount: payment.refundedAmount ?? 0,
				// Rows still to collect show today's 1%, not the rate when they were scheduled.
				fee: money.seekFee,
				payout: money.payout,
				holdingDepositCredit: payment.holdingDepositCredit ?? 0,
				payoutStatus: payment.payoutStatus ?? null,
				nextPayout: payoutsOnHold || payoutsPaused || held
					? null
					: estimateNextPayout({
						paidAt: payment.status === PaymentStatus.PAID && payment.paidAt ? [payment.paidAt] : [],
						openDueDates: open ? [payment.dueDate] : [],
						now: new Date()
					})
			};
		});
		return {
			month: range.label,
			...totals,
			payoutsOnHold,
			payoutsPaused,
			nextPayoutDate: payoutsOnHold || payoutsPaused ? null : await this.nextPayoutDate(landlordId),
			rows
		};
	}

	/**
	 * onHold: tenants can't pay this landlord by card yet (no connected account able to take card payments).
	 * paused: card payments work but Stripe has paused payouts to the bank, so no payout date can be promised.
	 */
	private async payoutState(landlordId: string): Promise<{ onHold: boolean; paused: boolean }> {
		if (this.mode() !== "stripe") return { onHold: false, paused: false };
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		let payoutsOff = false;
		try {
			const accountId = await this.accountFor(stripe, new Types.ObjectId(landlordId), account => {
				payoutsOff = account.payouts_enabled === false;
				return canCharge(account);
			});
			return { onHold: !accountId, paused: !!accountId && payoutsOff };
		} catch (error) {
			// Stripe couldn't be asked: no "finish setup" banner on a guess, and the Rent page still loads.
			this.logger.warn(`Payout status for landlord ${landlordId} could not be checked: ${(error as Error).message}`);
			return { onHold: false, paused: false };
		}
	}

	/**
	 * Money Seek collected while a landlord had no payout account goes to them,
	 * minus Seek's fee, once their account can take charges. Runs in the hourly
	 * sweep and when connect status turns ready; a failed transfer retries next run.
	 */
	async releaseHeldPayouts(landlordId?: Types.ObjectId): Promise<number> {
		if (this.mode() !== "stripe") return 0;
		const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
		const held = (await this.paymentModel
			// A deposit owed back to the student stays with Seek until it's refunded.
			.find({
				status: PaymentStatus.PAID,
				payoutStatus: PayoutStatus.HELD,
				// Only Seek's own legacy charges: a direct charge is already the landlord's money.
				stripeAccountId: null,
				refundFailed: { $ne: true },
				$or: [
					{ payoutReleaseStartedAt: null, refundDue: { $ne: true } },
					// Recover an interrupted Stripe call under the same idempotency key; a queued refund then reverses it.
					{ payoutReleaseStartedAt: { $lt: staleClaim } }
				],
				$expr: { $gt: [{ $subtract: ["$amount", { $ifNull: ["$refundedAmount", 0] }] }, 0] },
				...(landlordId ? { landlord: landlordId } : {})
			})
			.lean()
			.exec()) as PaymentLean[];
		if (held.length === 0) return 0;
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		const destinations = new Map<string, string | null>();
		let released = 0;
		for (const payment of held) {
			const claimed = await this.paymentModel
				.findOneAndUpdate(
					{
						_id: payment._id,
						status: PaymentStatus.PAID,
						payoutStatus: PayoutStatus.HELD,
						stripeAccountId: null,
						refundFailed: { $ne: true },
						$or: [
							{ payoutReleaseStartedAt: null, refundDue: { $ne: true } },
							{ payoutReleaseStartedAt: { $lt: staleClaim } }
						]
					},
					{ $set: { payoutReleaseStartedAt: new Date() } },
					{ new: true }
				)
				.lean()
				.exec() as PaymentLean | null;
			if (!claimed) continue;
			const payout = proportionalRefund(claimed.amount, claimed.refundedAmount ?? 0, claimed.seekFee).landlordNet;
			if (payout <= 0) {
				await this.paymentModel.updateOne({ _id: claimed._id, payoutStatus: PayoutStatus.HELD }, { $set: { payoutReleaseStartedAt: null } });
				continue;
			}
			const key = claimed.landlord.toString();
			if (!destinations.has(key)) {
				// Stripe couldn't be asked: the payout stays held and is retried next run.
				// A timeout or network error too: one landlord must not stop the hourly sweep.
				destinations.set(key, await this.accountFor(stripe, claimed.landlord, canTransfer).catch(error => {
					this.logger.warn(`Held payouts for landlord ${key} not released: Stripe account could not be checked (${error instanceof StripeApiError ? error.status : (error as Error).message})`);
					return null;
				}));
			}
			const destination = destinations.get(key);
			if (!destination) {
				await this.paymentModel.updateOne({ _id: claimed._id, payoutStatus: PayoutStatus.HELD }, { $set: { payoutReleaseStartedAt: null } });
				continue;
			}
			try {
				const charge = await this.chargeFor(stripe, claimed.providerRef);
				const transfer = await stripe.createTransfer(
					{
						amount: payout,
						currency: "gbp",
						destination,
						// Tied to the original charge, so it doesn't wait for Seek's balance to clear.
						...(charge ? { source_transaction: charge } : {}),
						metadata: this.stripeMetadata(claimed)
					},
					`seek-release-${claimed._id.toString()}`
				);
				await this.paymentModel.updateOne(
					{ _id: claimed._id, payoutStatus: PayoutStatus.HELD },
					{ $set: { payoutStatus: PayoutStatus.TRANSFERRED, transferRef: transfer.id, payoutReleaseStartedAt: null } }
				);
				released += 1;
			} catch (error) {
				if (error instanceof StripeApiError) {
					this.logger.warn(`Held payment ${claimed._id.toString()} not released yet (${error.status}): ${error.message}`);
					await this.paymentModel.updateOne({ _id: claimed._id, payoutStatus: PayoutStatus.HELD }, { $set: { payoutReleaseStartedAt: null } });
				} else {
					// shortcut: ambiguous Stripe result keeps the lock; an admin must reconcile in the Stripe dashboard — add automatic reconciliation by transfer metadata if this happens in practice
					this.logger.error(`Held payment ${claimed._id.toString()} has an ambiguous Stripe payout result: ${(error as Error).message}`);
				}
			}
		}
		return released;
	}

	/** The charge behind a paid intent or Checkout session. */
	private async chargeFor(stripe: StripeClient, providerRef: string | null): Promise<string | null> {
		if (providerRef?.startsWith("pi_")) return (await stripe.retrievePaymentIntent(providerRef)).latest_charge ?? null;
		if (providerRef?.startsWith("cs_")) {
			const intent = (await stripe.retrieveCheckoutSession(providerRef)).payment_intent;
			return typeof intent === "object" ? intent?.latest_charge ?? null : null;
		}
		return null;
	}

	private async nextPayoutDate(landlordId: string, now: Date = new Date()): Promise<Date | null> {
		const landlord = new Types.ObjectId(landlordId);
		const [paid, open] = await Promise.all([
			this.paymentModel
				.find({ landlord, status: PaymentStatus.PAID, payoutStatus: { $ne: PayoutStatus.HELD }, paidAt: { $gte: new Date(now.getTime() - 7 * DAY_MS) } })
				.select("paidAt")
				.lean()
				.exec(),
			this.paymentModel
				.find({ landlord, status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.PENDING] } })
				.sort({ dueDate: 1 })
				.limit(1)
				.select("dueDate")
				.lean()
				.exec()
		]);
		return estimateNextPayout({
			paidAt: paid.map(payment => payment.paidAt!).filter(Boolean),
			openDueDates: open.map(payment => payment.dueDate),
			now
		});
	}

	async getReminderSchedule(landlordId: string): Promise<ReminderSchedule> {
		const user = await this.userModel.findById(landlordId, { rentReminderSchedule: 1 }).lean().exec();
		return normaliseReminderSchedule(user?.rentReminderSchedule);
	}

	async updateReminderSchedule(landlordId: string, dto: UpdateReminderScheduleDto): Promise<ReminderSchedule> {
		const set: Record<string, boolean> = {};
		for (const key of ["beforeDue", "onDueDay", "lateAfterThreeDays"] as const) {
			if (dto[key] !== undefined) set[`rentReminderSchedule.${key}`] = dto[key]!;
		}
		if (Object.keys(set).length > 0) {
			await this.userModel.updateOne({ _id: landlordId }, { $set: set }).exec();
		}
		return this.getReminderSchedule(landlordId);
	}

	/**
	 * The landlord nudges tenants whose rent is late, all of them or the given
	 * payments. A tenant is reminded at most once every 24 hours.
	 */
	async remindLate(landlordId: string, dto: RemindLateDto, now: Date = new Date()): Promise<RemindLateResponseDto> {
		const filter: Record<string, unknown> = {
			landlord: new Types.ObjectId(landlordId),
			status: PaymentStatus.LATE
		};
		if (dto.payments?.length) filter._id = { $in: dto.payments.map(id => new Types.ObjectId(id)) };
		const late = await this.paymentModel.find(filter).lean().exec();

		let reminded = 0;
		let skipped = 0;
		for (const payment of late) {
			if (payment.lastReminderAt && now.getTime() - new Date(payment.lastReminderAt).getTime() < DAY_MS) {
				skipped += 1;
				continue;
			}
			const sent = await this.notifications.notify({
				user: payment.tenant,
				kind: NotificationKind.RENT_REMINDER,
				title: `Reminder: rent of ${formatPence(payment.amount)} is overdue`,
				body: `It was due on ${formatDay(payment.dueDate)}. Your landlord asked Seek to remind you.`,
				...notificationTarget("student", NotificationTargetKind.PAYMENTS),
				dedupeKey: `late-nudge:${payment._id.toString()}:${now.toISOString().slice(0, 10)}`
			});
			if (!sent) {
				skipped += 1;
				continue;
			}
			await this.deliverReminder(
				payment,
				`Reminder: rent of ${formatPence(payment.amount)} is overdue`,
				`It was due on ${formatDay(payment.dueDate)}. Your landlord asked Seek to remind you.`
			);
			await this.paymentModel.updateOne(
				{ _id: payment._id },
				{ $inc: { remindersSent: 1 }, $set: { lastReminderAt: now } }
			);
			reminded += 1;
		}
		return { reminded, skipped };
	}

	/**
	 * Besides the in-app notification, a reminder goes by email and into the
	 * household's Seek thread, so a tenant who never opens the app still hears.
	 * Never throws: a failed channel must not block the reminder bookkeeping.
	 */
	private async deliverReminder(payment: Pick<PaymentLean, "tenant" | "landlord" | "tenancy">, title: string, body: string) {
		try {
			const user = await this.userModel.findById(payment.tenant, { email: 1, name: 1 }).lean().exec();
			const name = user?.name ?? "there";
			if (this.mail && user?.email) {
				const { link } = notificationTarget("student", NotificationTargetKind.PAYMENTS);
				await this.mail.sendRentReminderEmail(user.email, name, title, body, link).catch(error =>
					this.logger.warn(`Rent reminder email to ${payment.tenant.toString()} failed: ${(error as Error).message}`)
				);
			}
			if (!this.conversations) return;
			// Hand-made tenancies have no application, so no thread to post in.
			const tenancy = await this.tenancyModel.findById(payment.tenancy, { application: 1 }).lean().exec();
			const application = tenancy?.application
				? await this.applicationModel.findById(tenancy.application, { conversation: 1 }).lean().exec()
				: null;
			if (!application?.conversation) return;
			await this.conversations.sendMessage(
				{ message: `Seek reminder for ${name}: ${title}. ${body}` },
				application.conversation.toString(),
				payment.landlord.toString()
			);
		} catch (error) {
			this.logger.warn(`Rent reminder delivery for ${payment.tenant.toString()} failed: ${(error as Error).message}`);
		}
	}

	/**
	 * The landlord reminds one tenant about one unpaid payment (scheduled,
	 * late or failed). Same 24-hour limit as remindLate.
	 */
	async remindOne(landlordId: string, paymentId: string, now: Date = new Date()): Promise<RemindLateResponseDto> {
		const payment = await this.findPayment(paymentId);
		if (payment.landlord.toString() !== landlordId) {
			throw new ForbiddenException("You can only remind your own tenants.");
		}
		if (!PAYABLE.includes(payment.status)) {
			throw new BadRequestException("Only unpaid payments can be reminded.");
		}
		if (payment.lastReminderAt && now.getTime() - new Date(payment.lastReminderAt).getTime() < DAY_MS) {
			return { reminded: 0, skipped: 1 };
		}
		const late = payment.status === PaymentStatus.LATE;
		const what = payment.kind === PaymentKind.HOLDING_DEPOSIT ? "Holding deposit" : "Rent";
		const title = late
			? `Reminder: ${what.toLowerCase()} of ${formatPence(payment.amount)} is overdue`
			: `Reminder: ${what.toLowerCase()} of ${formatPence(payment.amount)} is due ${formatDay(payment.dueDate)}`;
		const body = "Your landlord asked Seek to remind you. Pay in Seek in a couple of taps.";
		const sent = await this.notifications.notify({
			user: payment.tenant,
			kind: NotificationKind.RENT_REMINDER,
			title,
			body,
			...notificationTarget("student", NotificationTargetKind.PAYMENTS),
			dedupeKey: `nudge:${payment._id.toString()}:${now.toISOString().slice(0, 10)}`
		});
		if (!sent) return { reminded: 0, skipped: 1 };
		await this.deliverReminder(payment, title, body);
		await this.paymentModel.updateOne(
			{ _id: payment._id },
			{ $inc: { remindersSent: 1 }, $set: { lastReminderAt: now } }
		);
		return { reminded: 1, skipped: 0 };
	}

	/**
	 * Stripe only sends the payer back to Seek: the web app's origin or the app
	 * scheme. Outside production, localhost and Expo Go (exp://, exps://) too.
	 */
	private assertReturnUrl(url: string, web: string) {
		const production = this.config.get<string>("NODE_ENV") === "production";
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new BadRequestException("The return URL is not a valid URL.");
		}
		const http = /^https?:$/.test(parsed.protocol);
		const allowed = ["seekapp:", "seek:"].includes(parsed.protocol)
			|| (http && parsed.origin === new URL(web).origin)
			|| (!production && (["exp:", "exps:"].includes(parsed.protocol) || (http && ["localhost", "127.0.0.1"].includes(parsed.hostname))));
		if (!allowed) throw new BadRequestException("Return URLs must point back to Seek: the web app or the Seek app.");
	}

	/**
	 * Hosted Stripe Checkout for one payment. The landlord's connected account
	 * receives it minus Seek's fee when it can take charges; otherwise Seek
	 * collects it and pays out later. With autopay on, the card is saved for
	 * off-session charges. Simulated mode pays straight away.
	 */
	async checkout(
		paymentId: string,
		tenant: Viewer,
		query: CheckoutQueryDto,
		platform?: string
	): Promise<CheckoutResponseDto> {
		const payment = await this.findPayment(paymentId);
		if (payment.tenant.toString() !== tenant._id.toString()) {
			throw new ForbiddenException("You can only pay your own payments.");
		}
		const mobile = platform === "mobile";
		const web = (this.config.get<string>("FRONTEND_URL") || "http://localhost:5173").replace(/\/$/, "");
		const back = mobile ? "seekapp://rent-plan" : `${web}/student/home/rent`;
		// Expo's Linking.createURL gives seekapp:///pay, which Stripe rejects as "Not a valid URL"; seekapp://pay is accepted.
		const appUrl = (url: string) => url.replace(/^(seekapp|seek):\/\/\/+/, "$1://");
		const successUrl = appUrl(query.successUrl ?? `${back}?checkout=success&payment=${payment._id.toString()}&session_id={CHECKOUT_SESSION_ID}`);
		const cancelUrl = appUrl(query.cancelUrl ?? `${back}?checkout=cancelled&payment=${payment._id.toString()}`);
		this.assertReturnUrl(successUrl, web);
		this.assertReturnUrl(cancelUrl, web);

		if (payment.status === PaymentStatus.PAID) {
			return { mode: this.mode() === "stripe" ? "stripe" : "simulated", sessionId: null, url: null, status: payment.status };
		}
		if (!PAYABLE.includes(payment.status) && payment.status !== PaymentStatus.PENDING) {
			throw new BadRequestException("This payment cannot be paid.");
		}
		const offerEnds = await this.assertHoldingPayable(payment);
		const mode = this.mode();
		if (mode === "unavailable") {
			throw new ServiceUnavailableException("Card payments are not available right now. Please try again later.");
		}
		if (mode === "simulated") {
			const paid = await this.markPaid(payment, PaymentProvider.SIMULATED, `sim_${payment._id.toString()}`);
			return {
				mode,
				sessionId: null,
				url: successUrl.replace("{CHECKOUT_SESSION_ID}", "simulated"),
				status: (paid ?? payment).status
			};
		}

		try {
			// Inside the try: a Stripe outage is "try again" (503), not CARD_NOT_READY.
			const account = await this.accountFor(new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!), payment.landlord);
			const plan = payment.tenancy
				? await this.planModel.findOne({ tenancy: payment.tenancy, tenant: payment.tenant }, { autopay: 1 }).lean().exec()
				: null;
			const saveCard = Boolean(plan?.autopay) && payment.kind !== PaymentKind.HOLDING_DEPOSIT;
			if (payment.providerRef?.startsWith("cs_")) {
				const previous = this.stripeFor(payment);
				const existing = await unlessGone(previous.retrieveCheckoutSession(payment.providerRef), checkoutLapsed(payment));
				if (existing?.status === "open" && existing.url) {
					if (account && payment.stripeAccountId === account && existing.success_url === successUrl && existing.cancel_url === cancelUrl
						// A row repriced since (early tenancy end) must not be paid at the old amount.
						&& existing.amount_total === payment.amount
						// A session opened before autopay was switched on (or off) would not save the card as asked.
						&& (existing.customer_creation === "always") === saveCard) {
						return { mode, sessionId: existing.id, url: existing.url, status: payment.status };
					}
					// Opened from the other client (web vs app), or its charge would land on another account (Seek's, for a legacy session).
					await unlessGone(previous.expireCheckoutSession(existing.id));
				}
				if (existing?.payment_status === "paid") {
					const done = await this.completeCheckout(existing, payment.stripeAccountId ?? null);
					return { mode, sessionId: existing.id, url: successUrl.replace("{CHECKOUT_SESSION_ID}", existing.id), status: done?.status ?? payment.status };
				}
			}
			// An intent from POST /pay on another account (Seek's, for a legacy one) is settled or cancelled, never left to charge too.
			if (payment.providerRef?.startsWith("pi_") && payment.provider === PaymentProvider.STRIPE && (!account || payment.stripeAccountId !== account)) {
				const previous = this.stripeFor(payment);
				const existing = await unlessGone(previous.retrievePaymentIntent(payment.providerRef));
				// Same guard as the webhook: a mismatched amount is left to it (it refunds).
				if (existing?.status === "succeeded" && existing.amount === payment.amount) {
					const paid = await this.markPaid(payment, PaymentProvider.STRIPE, existing.id);
					return { mode, sessionId: null, url: successUrl.replace("{CHECKOUT_SESSION_ID}", existing.id), status: (paid ?? payment).status };
				}
				if (existing && OPEN_INTENT_STATUSES.includes(existing.status)) await unlessGone(previous.cancelPaymentIntent(existing.id));
			}
			if (!account) throw new BadRequestException(CARD_NOT_READY);
			// A holding deposit's session closes with its offer. Stripe allows 30 minutes to 24 hours;
			// whole minutes keep the idempotency key stable across a double tap.
			const closesAt = offerEnds
				? Math.floor(Math.min(Math.max(offerEnds.getTime(), Date.now() + 31 * 60_000), Date.now() + 23 * 3_600_000) / 60_000) * 60
				: null;
			const body = {
					mode: "payment",
					line_items: [
						{
							quantity: 1,
							price_data: {
								currency: "gbp",
								unit_amount: payment.amount,
								product_data: { name: await this.describe(payment) }
							}
						}
					],
					payment_intent_data: {
						...seekFeeParams(feeFor(payment).seekFee),
						...(saveCard ? { setup_future_usage: "off_session" } : {}),
						metadata: this.stripeMetadata(payment)
					},
					// The card for autopay is saved on a customer on the landlord's account, where the charges live.
					...(saveCard ? { customer_creation: "always" } : {}),
					metadata: this.stripeMetadata(payment),
					...(closesAt ? { expires_at: closesAt } : {}),
					success_url: successUrl,
					cancel_url: cancelUrl
				};
			await this.bindAccount(payment, account);
			// Keyed on the whole request: a changed amount, account or autopay choice is a new session.
			const session = await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!, account).createCheckoutSession(
				body,
				`seek-checkout-${payment._id.toString()}-${payment.providerRef ?? "first"}-${createHash("sha256").update(account + JSON.stringify(body)).digest("hex").slice(0, 32)}`
			);
			// Remember the session so a second tap reuses it instead of opening a second charge.
			await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
				{ $set: { provider: PaymentProvider.STRIPE, providerRef: session.id } }
			);
			return { mode, sessionId: session.id, url: session.url ?? successUrl, status: payment.status };
		} catch (error) {
			if (error instanceof StripeApiError) {
				this.logger.error(`Stripe Checkout error ${error.status} for payment ${payment._id.toString()}: ${error.message}`);
				throw new ServiceUnavailableException("The card payment could not be started. Please try again.");
			}
			throw error;
		}
	}

	/** After Stripe redirects back: marks the payment paid and keeps the card for autopay. */
	async confirmCheckout(paymentId: string, sessionId: string, tenant: Viewer) {
		const payment = await this.findPayment(paymentId);
		if (payment.tenant.toString() !== tenant._id.toString()) {
			throw new ForbiddenException("You can only confirm your own payments.");
		}
		if (this.mode() !== "stripe") return this.payResponse(payment, null);
		// Back from a checkout() that found the payment already paid by its PaymentIntent: nothing to read.
		if (payment.status === PaymentStatus.PAID && sessionId === payment.providerRef) return this.payResponse(payment, null);
		let session: StripeCheckoutSession;
		try {
			session = await this.stripeFor(payment).retrieveCheckoutSession(sessionId);
		} catch (error) {
			if (error instanceof StripeApiError) {
				throw error.status === 404
					? new NotFoundException("Checkout session not found.")
					: new ServiceUnavailableException("The payment could not be checked. Please try again.");
			}
			throw error;
		}
		if (session.metadata?.paymentId !== payment._id.toString()) {
			throw new BadRequestException("This checkout session is for another payment.");
		}
		const updated = await this.completeCheckout(session, payment.stripeAccountId ?? null);
		return this.payResponse(updated ?? (await this.findPayment(paymentId)), null);
	}

	/**
	 * Shared by the redirect confirm and the checkout.session.completed webhook.
	 * `account` is the connected account the session was read from (null: Seek's platform).
	 */
	private async completeCheckout(session: StripeCheckoutSession | undefined, account: string | null) {
		const paymentId = session?.metadata?.paymentId;
		if (!session?.id || !paymentId || !Types.ObjectId.isValid(paymentId)) return null;
		const payment = await this.paymentModel.findById(paymentId).lean().exec();
		const intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
		const intentId = typeof session.payment_intent === "string" ? session.payment_intent : intent?.id;
		if (!payment) {
			this.logger.warn(`Checkout session ${session.id} for unknown payment`);
			await this.refundOrphanCheckout(session, intentId, account);
			return null;
		}
		// A session on any other account than the one Seek opened it on never settles this payment, and its money goes back.
		if ((payment.stripeAccountId ?? null) !== account) {
			this.logger.warn(`Checkout session ${session.id} for payment ${payment._id.toString()} is on account ${account ?? "platform"}, expected ${payment.stripeAccountId ?? "platform"}: ignored`);
			if (session.payment_status === "paid" && intentId) await this.refundCharge(intentId, "duplicate", account);
			return null;
		}
		if (typeof session.amount_total === "number" && session.amount_total !== payment.amount) {
			this.logger.error(`Stripe amount mismatch for payment ${payment._id.toString()} (session ${session.id}): charged ${session.amount_total}, expected ${payment.amount}`);
			if (session.payment_status === "paid" && intentId) await this.refundCharge(intentId, "requested_by_customer", account);
			return null;
		}
		if (session.payment_status !== "paid") return payment as PaymentLean;

		const paid = await this.markPaid(payment as PaymentLean, PaymentProvider.STRIPE, intentId ?? session.id);
		if (!paid && intentId) await this.refundIfDuplicate(payment._id, intentId, account, session.id);
		// The card and its customer live on the landlord's account: autopay charges there with both.
		if (account && intent?.payment_method && session.customer && payment.tenancy) {
			await this.planModel.updateOne(
				{ tenancy: payment.tenancy, tenant: payment.tenant, autopay: true },
				{ $set: { paymentMethodId: intent.payment_method, stripeCustomerId: session.customer } }
			);
		}
		return paid ?? (payment as PaymentLean);
	}

	/**
	 * A second successful charge on an already-paid payment (autopay and an open
	 * Checkout, say) is refunded, never kept. Same charge seen twice: nothing.
	 */
	private async refundIfDuplicate(paymentId: Types.ObjectId, intentId: string, account: string | null, sessionId?: string) {
		const current = await this.paymentModel.findById(paymentId, { status: 1, providerRef: 1 }).lean().exec();
		if (current?.status !== PaymentStatus.PAID || current.providerRef === intentId || (sessionId && current.providerRef === sessionId)) return;
		this.logger.error(`Duplicate charge ${intentId} on payment ${paymentId.toString()} already paid by ${current.providerRef}: refunding it`);
		await this.refundCharge(intentId, "duplicate", account);
	}

	/**
	 * A paid Seek session whose payment row is gone (unpaid rent removed when a tenancy ended, say):
	 * no row will ever record that money, so it goes back. Only when Seek's own metadata names the
	 * deleted payment and no other row holds this charge.
	 */
	private async refundOrphanCheckout(session: StripeCheckoutSession, intentId: string | undefined, account: string | null) {
		const meta = session.metadata ?? {};
		if (session.payment_status !== "paid" || !intentId) return;
		if (!Object.values(PaymentKind).includes(meta.kind as PaymentKind) || !meta.tenantId || !Types.ObjectId.isValid(meta.tenantId)) return;
		if (await this.paymentModel.exists({ providerRef: { $in: [intentId, session.id] } })) return;
		this.logger.error(`Paid checkout session ${session.id} for deleted payment ${meta.paymentId}: refunding ${intentId}`);
		await this.refundCharge(intentId, "requested_by_customer", account);
	}

	/** Refunds a whole charge on the account it was made on, idempotently per intent. */
	private async refundCharge(intentId: string, reason: "duplicate" | "requested_by_customer", account: string | null) {
		await refundStripeCharge({ secretKey: this.config.get<string>("STRIPE_SECRET_KEY")!, intentId, reason, account: account ?? undefined });
	}

	/** Stripe client acting where this payment's charge lives: the landlord's account, or Seek's for legacy rows. */
	private stripeFor(payment: Pick<Payment, "stripeAccountId">) {
		return new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!, payment.stripeAccountId ?? undefined);
	}

	/**
	 * Records the account a charge is about to be made on before Stripe is called, so its webhook matches.
	 * Never HELD: the money is the landlord's from the start. A reference on another account was closed by the caller.
	 */
	private async bindAccount(payment: PaymentLean, account: string) {
		await this.paymentModel.updateOne(
			{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
			{ $set: { stripeAccountId: account, payoutStatus: null, ...(payment.stripeAccountId === account ? {} : { providerRef: null }) } }
		);
	}

	/** Drops a connected account Stripe no longer knows, unless the landlord already has another one. */
	private async forgetAccount(landlordId: Types.ObjectId | string, accountId: string) {
		await this.userModel.updateOne({ _id: landlordId, stripeAccountId: accountId }, { $unset: { stripeAccountId: 1, payoutBank: 1 } });
	}

	/** The landlord's connected account, when Stripe lets it take card payments (or, for legacy releases, transfers). */
	private async accountFor(stripe: StripeClient, landlordId: Types.ObjectId, ready = canCharge): Promise<string | null> {
		const landlord = await this.userModel.findById(landlordId, { stripeAccountId: 1, suspendedAt: 1, deletedAt: 1 }).lean().exec();
		const accountId = landlord?.stripeAccountId;
		// A suspended or deleted landlord takes no card payments (and gets no legacy release until the suspension is lifted).
		if (landlord?.suspendedAt || landlord?.deletedAt) return null;
		if (!accountId || accountId.startsWith("acct_sim_")) return null;
		try {
			const account = await stripe.retrieveAccount(accountId);
			return ready(account) ? accountId : null;
		} catch (error) {
			// Only a definite answer (no such account, access revoked) means "not set up"; a rate limit or outage is rethrown.
			if (error instanceof StripeApiError && (error.status === 403 || error.status === 404)) return null;
			throw error;
		}
	}

	private stripeMetadata(payment: PaymentLean) {
		return {
			paymentId: payment._id.toString(),
			kind: payment.kind ?? PaymentKind.RENT,
			tenancyId: payment.tenancy ? payment.tenancy.toString() : "",
			tenantId: payment.tenant.toString()
		};
	}

	private async describe(payment: PaymentLean): Promise<string> {
		if (payment.kind === PaymentKind.HOLDING_DEPOSIT) return "Holding deposit";
		const tenancy = await this.tenancyModel
			.findById(payment.tenancy)
			.populate({ path: "listing", select: "propertyTitle streetAddress" })
			.lean()
			.exec();
		const listing = tenancy?.listing as unknown as Listing | undefined;
		return `Rent for ${listing?.propertyTitle ?? listing?.streetAddress ?? "your home"}, due ${formatDay(payment.dueDate)}`;
	}

	/**
	 * Creates the landlord's Stripe connected account (Accounts v2, merchant card payments) the first time and returns
	 * Stripe's onboarding link. Without a Stripe key (development) the account
	 * is simulated and ready immediately.
	 */
	async connectOnboard(landlord: Viewer & { email?: string }): Promise<ConnectOnboardResponseDto> {
		const mode = this.mode();
		if (mode === "unavailable") {
			throw new ServiceUnavailableException("Payouts cannot be set up right now. Please try again later.");
		}
		const user = await this.userModel.findById(landlord._id, { stripeAccountId: 1, email: 1 }).lean().exec();
		if (!user) throw new NotFoundException("User not found.");

		if (mode === "simulated") {
			const accountId = user.stripeAccountId ?? `acct_sim_${landlord._id.toString()}`;
			if (!user.stripeAccountId) {
				await this.userModel.updateOne({ _id: landlord._id }, { $set: { stripeAccountId: accountId } }).exec();
			}
			return { mode: "simulated", accountId, url: null };
		}

		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		const create = async (idempotencyKey: string) => {
			const account = await stripe.createRecipientAccount(
				{
					...(user.email ? { contact_email: user.email } : {}),
					metadata: { userId: landlord._id.toString() }
				},
				idempotencyKey
			);
			await this.userModel.updateOne({ _id: landlord._id }, { $set: { stripeAccountId: account.id } }).exec();
			return account.id;
		};
		const frontend = this.config.get<string>("FRONTEND_URL") ?? "";
		const link = (account: string) => stripe.createAccountLink({
			account,
			return_url: this.config.get<string>("STRIPE_CONNECT_RETURN_URL") || `${frontend}/edit-profile?connect=return`,
			refresh_url: this.config.get<string>("STRIPE_CONNECT_REFRESH_URL") || `${frontend}/edit-profile?connect=refresh`
		});
		const stored = user.stripeAccountId;
		try {
			let accountId = stored ?? (await create(`seek-connect-${landlord._id.toString()}`));
			let url: string;
			try {
				if (stored) {
					// Accounts made before direct charges were recipient-only: ask for card payments so onboarding collects what they need.
					// shortcut: v2 update body for merchant card_payments follows Stripe's documented shape, confirm in test mode
					await stripe.updateAccount(stored, { configuration: { merchant: { capabilities: { card_payments: { requested: true } } } } })
						.catch((error: Error) => {
							if (isGoneAccount(error)) throw error;
							this.logger.error(`Requesting card payments on ${stored} failed: ${error.message}`);
						});
				}
				url = (await link(accountId)).url;
			} catch (error) {
				if (!stored || !isGoneAccount(error)) throw error;
				// The stored account doesn't exist for this Stripe key (e.g. a test id after going live): start a new one.
				this.logger.warn(`Stripe account ${stored} is gone (${error.status}); creating a new one for ${landlord._id.toString()}`);
				await this.forgetAccount(landlord._id, stored);
				accountId = await create(`seek-connect-${landlord._id.toString()}-${stored}`);
				url = (await link(accountId)).url;
			}
			return { mode: "stripe", accountId, url };
		} catch (error) {
			if (error instanceof StripeApiError) {
				this.logger.error(`Stripe Connect onboarding failed (${error.status} ${error.code ?? "no code"}): ${error.message}`);
				if (CONNECT_NOT_ENABLED.has(error.code ?? "") || /signed up for Connect/i.test(error.message)) {
					throw new ConflictException(
						"Card payments and payouts aren't available yet: Stripe Connect is not enabled for Seek. Tenants can pay you by bank transfer in the meantime."
					);
				}
				throw new BadGatewayException("Payout setup could not be started. Please try again.");
			}
			throw error;
		}
	}

	async connectStatus(landlordId: string): Promise<ConnectStatusDto> {
		const mode = this.mode();
		const user = await this.userModel.findById(landlordId, { stripeAccountId: 1, payoutBank: 1 }).lean().exec();
		const accountId = user?.stripeAccountId ?? null;
		const none = {
			mode,
			connected: false,
			accountId,
			chargesEnabled: false,
			payoutsEnabled: false,
			detailsSubmitted: false,
			payoutBank: user?.payoutBank ?? null
		};
		if (!accountId) return none;
		if (mode !== "stripe") {
			const ready = mode === "simulated";
			return { ...none, connected: true, chargesEnabled: ready, payoutsEnabled: ready, detailsSubmitted: ready };
		}
		try {
			const account = await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!).retrieveAccount(accountId);
			const bank = account.external_accounts?.data?.[0];
			const payoutBank = bank
				? { last4: bank.last4 ?? null, bankName: bank.bank_name ?? null, verified: bank.status === "verified", status: bank.status ?? null }
				: null;
			await this.userModel.updateOne({ _id: landlordId }, payoutBank ? { $set: { payoutBank } } : { $unset: { payoutBank: 1 } });
			// Legacy: money Seek held before direct charges goes out as soon as transfers are possible.
			if (canTransfer(account)) {
				await this.releaseHeldPayouts(new Types.ObjectId(landlordId)).catch((error: Error) =>
					this.logger.error(`Releasing held payouts failed: ${error.message}`)
				);
			}
			return {
				...none,
				payoutBank,
				connected: true,
				chargesEnabled: canCharge(account),
				payoutsEnabled: account.payouts_enabled,
				detailsSubmitted: account.details_submitted
			};
		} catch (error) {
			if (isGoneAccount(error)) {
				// Not this Stripe key's account (e.g. a test id after going live): the landlord starts onboarding again.
				this.logger.warn(`Stripe account ${accountId} is gone (${error.status}); forgetting it`);
				await this.forgetAccount(landlordId, accountId);
				return { ...none, accountId: null, payoutBank: null };
			}
			if (error instanceof StripeApiError) {
				this.logger.error(`Stripe account lookup failed (${error.status}): ${error.message}`);
				throw new ServiceUnavailableException("Payout status could not be checked. Please try again.");
			}
			throw error;
		}
	}

	/**
	 * Hourly job: simulated autopay, late marking, reminders and compliance
	 * alerts. Every step is idempotent so overlapping runs are harmless.
	 */
	async sweep(now: Date = new Date()) {
		await this.endFinishedTenancies(now);
		await this.clearLapsedNotices(now);
		const today = startOfUtcDay(now);
		const mode = this.mode();

		if (mode === "simulated") {
			const autopayPlans = await this.planModel.find({ autopay: true }, { tenancy: 1, tenant: 1 }).lean().exec();
			for (const plan of autopayPlans) {
				const due = await this.paymentModel
					.find({
						tenancy: plan.tenancy,
						tenant: plan.tenant,
						status: PaymentStatus.SCHEDULED,
						dueDate: { $lte: now }
					})
					.lean()
					.exec();
				for (const payment of due) {
					await this.markPaid(payment as PaymentLean, PaymentProvider.SIMULATED, `sim_${payment._id.toString()}`);
				}
			}
		}

		if (mode === "stripe") {
			await this.sweepStripeAutopay(now);
			await this.releaseHeldPayouts();
		}

		const overdue = await this.paymentModel
			// Holding deposits lapse with their offer instead of going late.
			.find({
				kind: { $ne: PaymentKind.HOLDING_DEPOSIT },
				amount: { $gt: 0 },
				$or: [
					{ status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.FAILED] } },
					// An abandoned payment sheet or a crashed autopay leaves PENDING behind; an hour lets live attempts settle.
					{ status: PaymentStatus.PENDING, updatedAt: { $lt: new Date(now.getTime() - 60 * 60 * 1000) } }
				],
				dueDate: { $lt: today }
			})
			.lean()
			.exec();
		for (const payment of overdue) {
			if (payment.status === PaymentStatus.PENDING && !(await this.pendingAttemptDead(payment as PaymentLean))) continue;
			const result = await this.paymentModel.updateOne(
				{ _id: payment._id, status: payment.status },
				{ $set: { status: PaymentStatus.LATE } }
			);
			if (result.modifiedCount === 0) continue;
			const tenant = await this.userModel.findById(payment.tenant, { name: 1 }).lean().exec();
			await this.notifications.notify({
				user: payment.tenant,
				kind: NotificationKind.RENT_LATE,
				title: `Rent of ${formatPence(payment.amount)} is overdue`,
				body: `It was due on ${formatDay(payment.dueDate)}. Pay now to keep your record clean.`,
				...notificationTarget("student", NotificationTargetKind.PAYMENTS),
				dedupeKey: `late:${payment._id.toString()}`
			});
			await this.notifications.notify({
				user: payment.landlord,
				kind: NotificationKind.RENT_LATE,
				title: `${tenant?.name ?? "A tenant"}'s rent is late`,
				body: `${formatPence(payment.amount)} was due on ${formatDay(payment.dueDate)}.`,
				...notificationTarget("landlord", NotificationTargetKind.PAYMENTS),
				dedupeKey: `late:${payment._id.toString()}`
			});
		}

		const schedules = new Map<string, ReminderSchedule>();
		const scheduleFor = async (landlord: Types.ObjectId) => {
			const key = landlord.toString();
			if (!schedules.has(key)) schedules.set(key, await this.getReminderSchedule(key));
			return schedules.get(key)!;
		};
		// Days-before comes from each tenant's notificationPrefs (default 3).
		const reminderDays = new Map<string, number>();
		const reminderDaysFor = async (tenantId: Types.ObjectId) => {
			const key = tenantId.toString();
			if (!reminderDays.has(key)) {
				const user = await this.userModel.findById(tenantId, { notificationPrefs: 1 }).lean().exec();
				const value = user?.notificationPrefs?.rentReminderDaysBefore;
				reminderDays.set(key, typeof value === "number" && value >= 0 && value <= 14 ? value : 3);
			}
			return reminderDays.get(key)!;
		};
		const reminderCandidates = await this.paymentModel
			.find({
				kind: { $ne: PaymentKind.HOLDING_DEPOSIT },
				$or: [
					{
						status: PaymentStatus.SCHEDULED,
						dueDate: { $gte: today, $lte: new Date(now.getTime() + 14 * DAY_MS) }
					},
					{ status: PaymentStatus.LATE, dueDate: { $lt: today } }
				]
			})
			.lean()
			.exec();
		for (const payment of reminderCandidates) {
			const plan = await this.planModel
				.findOne({ tenancy: payment.tenancy, tenant: payment.tenant }, { autopay: 1, paymentMethodId: 1, remindDaysBefore: 1 })
				.lean()
				.exec();
			const stage = dueReminderStage({
				status: payment.status,
				dueDate: payment.dueDate,
				today,
				remindDaysBefore: plan?.remindDaysBefore ?? await reminderDaysFor(payment.tenant),
				schedule: await scheduleFor(payment.landlord)
			});
			if (!stage) continue;
			const daysLate = Math.round((today.getTime() - startOfUtcDay(payment.dueDate).getTime()) / DAY_MS);
			const title = stage === "LATE"
				? `Rent of ${formatPence(payment.amount)} is ${daysLate} days overdue`
				: stage === "DUE_DAY"
					? `Rent of ${formatPence(payment.amount)} is due today`
					: `Rent of ${formatPence(payment.amount)} is due on ${formatDay(payment.dueDate)}`;
			const body = stage === "LATE"
				? "Pay now to keep your record clean."
				: plan?.autopay && (this.mode() !== "stripe" || plan.paymentMethodId) ? "Autopay will take it automatically." : "Pay in Seek in a couple of taps.";
			const sent = await this.notifications.notify({
				user: payment.tenant,
				kind: NotificationKind.RENT_REMINDER,
				title,
				body,
				...notificationTarget("student", NotificationTargetKind.PAYMENTS),
				dedupeKey: `reminder:${payment._id.toString()}:${stage}`
			});
			if (sent) {
				await this.deliverReminder(payment, title, body);
				await this.paymentModel.updateOne(
					{ _id: payment._id },
					{ $inc: { remindersSent: 1 }, $set: { lastReminderAt: now } }
				);
			}
		}

		await this.sweepCompliance(now);
	}

	/** Retries automatic refunds that could not run before their Stripe payment settled. */
	async refundDuePayments() {
		const due = await this.paymentModel
			.find({ refundDue: true, autoRefund: true, refundFailed: { $ne: true }, status: PaymentStatus.PAID, refundedAt: null })
			.lean()
			.exec();
		for (const payment of due) {
			const accepted = await refundPayment(
				this.paymentModel,
				payment as PaymentLean,
				this.config.get<string>("STRIPE_SECRET_KEY"),
				payment.refundAmount || payment.amount
			);
			await notifyHoldingRefund(this.notifications, this.paymentModel, payment as PaymentLean, accepted);
		}
	}

	/** Keeps a year of rent scheduled for every active tenancy (buildSchedule only goes 12 months ahead). */
	async extendSchedules(now: Date = new Date()) {
		const tenancies = await this.tenancyModel
			.find(
				{ status: TenancyStatus.ACTIVE, $or: [{ endDate: null }, { endDate: { $gt: startOfUtcDay(now) } }] },
				{ landlord: 1, tenants: 1, startDate: 1, endDate: 1, monthlyRent: 1, application: 1, listing: 1, noticeGivenAt: 1 }
			)
			.lean()
			.exec();
		if (tenancies.length === 0) return;
		const plans = await this.planModel
			.find({ tenancy: { $in: tenancies.map(tenancy => tenancy._id) } }, { tenancy: 1, tenant: 1, frequency: 1 })
			.lean()
			.exec();
		const byId = new Map(tenancies.map(tenancy => [tenancy._id.toString(), tenancy]));
		for (const plan of plans) {
			const tenancy = byId.get(plan.tenancy.toString());
			if (tenancy) await this.rentSchedule.extend(tenancy, plan.tenant, plan.frequency, now);
		}
	}

	/**
	 * A stale PENDING row goes late only once Stripe says its attempt is over: a bank debit can sit in
	 * "processing" for days, and a late row is payable again. Settled ones are marked paid; no answer means wait.
	 */
	private async pendingAttemptDead(payment: PaymentLean): Promise<boolean> {
		if (!payment.providerRef) return true;
		if (this.mode() !== "stripe") return false;
		const stripe = this.stripeFor(payment);
		try {
			if (payment.providerRef.startsWith("cs_")) {
				const session = await unlessGone(stripe.retrieveCheckoutSession(payment.providerRef), checkoutLapsed(payment));
				if (!session) return true;
				if (session.payment_status === "paid") await this.completeCheckout(session, payment.stripeAccountId ?? null);
				return session.status === "expired";
			}
			if (!payment.providerRef.startsWith("pi_")) return false;
			const intent = await unlessGone(stripe.retrievePaymentIntent(payment.providerRef));
			if (!intent) return true;
			// Same guard as the webhook: a mismatched amount is left to it (it refunds).
			if (intent.status === "succeeded" && intent.amount === payment.amount) await this.markPaid(payment, PaymentProvider.STRIPE, intent.id);
			return ["canceled", "requires_payment_method"].includes(intent.status);
		} catch (error) {
			this.logger.warn(`Pending payment ${payment._id.toString()} left pending: Stripe could not be checked (${error instanceof StripeApiError ? error.status : (error as Error).message})`);
			return false;
		}
	}

	/** Charges due instalments off-session with the card saved at Checkout. */
	private async sweepStripeAutopay(now: Date) {
		const plans = await this.planModel
			// Naming the select:false field in the projection includes it.
			.find({ autopay: true, paymentMethodId: { $exists: true } }, { tenancy: 1, tenant: 1, paymentMethodId: 1, stripeCustomerId: 1 })
			.lean()
			.exec();
		if (plans.length === 0) return;
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		// undefined: Stripe couldn't be asked this sweep.
		const accounts = new Map<string, string | null | undefined>();
		for (const plan of plans) {
			// A card saved before direct charges (on Seek's account, no plan customer) is never charged again.
			if (!plan.stripeCustomerId || !plan.paymentMethodId) continue;
			const due = await this.paymentModel
				.find({ tenancy: plan.tenancy, tenant: plan.tenant, status: PaymentStatus.SCHEDULED, dueDate: { $lte: now } })
				.lean()
				.exec();
			for (const payment of due as PaymentLean[]) {
				const key = payment.landlord.toString();
				if (!accounts.has(key)) {
					try {
						accounts.set(key, await this.accountFor(stripe, payment.landlord));
					} catch (error) {
						this.logger.warn(`Autopay for landlord ${key} deferred: Stripe account could not be checked (${error instanceof StripeApiError ? error.status : (error as Error).message})`);
						accounts.set(key, undefined);
					}
				}
				const account = accounts.get(key);
				// Not notified: the dedupeKey below is used once per payment, and the row stays SCHEDULED for the next sweep.
				if (account === undefined) continue;
				if (!account) {
					// Seek never collects rent itself: the tenant pays another way and the row stays SCHEDULED.
					this.logger.warn(`Autopay skipped for payment ${payment._id.toString()}: the landlord can't take card payments yet`);
					// Told once per payment, so a LATE notice never comes as a surprise.
					await this.notifications.notify({
						user: payment.tenant,
						kind: NotificationKind.PAYMENT_FAILED,
						title: `Autopay of ${formatPence(payment.amount)} didn't run`,
						body: "Your landlord can't take card payments on Seek yet, so autopay didn't run. Please pay by bank transfer or ask them to finish setup.",
						...notificationTarget("student", NotificationTargetKind.PAYMENTS),
						dedupeKey: `autopay-skipped:${payment._id.toString()}`
					});
					await this.notifications.notify({
						user: payment.landlord,
						kind: NotificationKind.PAYMENT_FAILED,
						title: "Finish Stripe setup to take rent by card",
						body: `Autopay of ${formatPence(payment.amount)} couldn't run because card payments aren't set up on your account yet.`,
						...notificationTarget("landlord", NotificationTargetKind.PAYMENTS),
						dedupeKey: `autopay-skipped:${payment._id.toString()}`
					});
					continue;
				}
				// An open Checkout page could still be paid: close it first, or leave the instalment to it.
				if (payment.providerRef?.startsWith("cs_")) {
					try {
						const previous = this.stripeFor(payment);
						const session = await unlessGone(previous.retrieveCheckoutSession(payment.providerRef), checkoutLapsed(payment));
						if (session?.status === "open") await unlessGone(previous.expireCheckoutSession(session.id));
						else if (session && session.status !== "expired") {
							await this.completeCheckout(session, payment.stripeAccountId ?? null);
							continue;
						}
					} catch (error) {
						this.logger.warn(`Autopay skipped for payment ${payment._id.toString()}: its Checkout session could not be closed (${error instanceof StripeApiError ? error.status : (error as Error).message})`);
						continue;
					}
				}
				// Claim it first so overlapping sweeps never charge twice.
				const claimed = await this.paymentModel.updateOne(
					{ _id: payment._id, status: PaymentStatus.SCHEDULED },
					{ $set: { status: PaymentStatus.PENDING, provider: PaymentProvider.STRIPE } }
				);
				if (claimed.modifiedCount === 0) continue;
				try {
					await this.bindAccount(payment, account);
					const intent = await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!, account).createPaymentIntent(
						{
							amount: payment.amount,
							currency: "gbp",
							customer: plan.stripeCustomerId,
							payment_method: plan.paymentMethodId,
							off_session: true,
							confirm: true,
							...seekFeeParams(feeFor(payment).seekFee),
							description: await this.describe(payment),
							metadata: this.stripeMetadata(payment)
						},
						`seek-autopay-${payment._id.toString()}`
					);
					await this.paymentModel.updateOne(
						{ _id: payment._id },
						{ $set: { providerRef: intent.id } }
					);
					if (intent.status === "succeeded") await this.markPaid(payment, PaymentProvider.STRIPE, intent.id);
				} catch (error) {
					if (!(error instanceof StripeApiError) || error.status === 429 || error.status >= 500) {
						// No answer from Stripe (timeout, network, rate limit, outage): back to SCHEDULED so the next sweep
						// retries until the overdue step turns it LATE; the seek-autopay idempotency key returns the same intent if one was created.
						this.logger.error(`Autopay for payment ${payment._id.toString()} got no answer from Stripe, retrying next sweep: ${error instanceof StripeApiError ? error.status : (error as Error).message}`);
						await this.paymentModel.updateOne(
							{ _id: payment._id, status: PaymentStatus.PENDING },
							{ $set: { status: PaymentStatus.SCHEDULED } }
						);
						continue;
					}
					this.logger.warn(`Autopay failed for payment ${payment._id.toString()} (${error.status})`);
					const failed = await this.paymentModel.updateOne(
						{ _id: payment._id, status: PaymentStatus.PENDING },
						{ $set: { status: PaymentStatus.FAILED } }
					);
					if (failed.modifiedCount > 0) await this.notifications.notify({
						user: payment.tenant,
						kind: NotificationKind.PAYMENT_FAILED,
						title: `Autopay of ${formatPence(payment.amount)} didn't go through`,
						body: "Pay now with another card to keep your record clean.",
						...notificationTarget("student", NotificationTargetKind.PAYMENTS),
						dedupeKey: `autopay-failed:${payment._id.toString()}`
					});
				}
			}
		}
	}

	/** A housemate's notice date that no longer leaves the full notice period has lapsed: clear it so the tenants can give notice again. */
	private async clearLapsedNotices(now: Date) {
		const today = londonCalendarDay(now);
		const pending = await this.tenancyModel
			.find({ status: TenancyStatus.ACTIVE, noticeGivenAt: null, noticeEndDate: { $ne: null } }, { startDate: 1, noticeEndDate: 1, listing: 1 })
			.populate({ path: "listing", select: "nation" })
			.lean()
			.exec();
		for (const tenancy of pending) {
			const nation = (tenancy.listing as unknown as { nation?: Nation } | null)?.nation ?? Nation.ENGLAND;
			if (new Date(tenancy.noticeEndDate!) >= earliestNoticeEnd(nation, tenancy.startDate, today)) continue;
			await this.tenancyModel.updateOne(
				{ _id: tenancy._id, noticeGivenAt: null, noticeEndDate: tenancy.noticeEndDate },
				{ $set: { noticeEndDate: null, noticeFrom: [], noticeGivenBy: null } }
			);
		}
	}

	/**
	 * A fixed term ends on its own once its end date (exclusive, London day) arrives; a rolling tenancy runs until ended.
	 * Only Northern Ireland has fixed terms: elsewhere the law keeps the tenancy going, so an older one with an end date rolls on.
	 * A tenancy with notice given (by its tenants, or a future end date set by the landlord) ends on that date.
	 */
	private async endFinishedTenancies(now: Date) {
		const today = londonCalendarDay(now);
		const finished = await this.tenancyModel
			.find({ status: TenancyStatus.ACTIVE, endDate: { $ne: null, $lte: today }, $or: [{ periodic: false }, { noticeGivenAt: { $ne: null } }] })
			.populate({ path: "listing", select: "propertyTitle streetAddress nation" })
			.lean()
			.exec();
		for (const tenancy of finished) {
			if (!tenancy.noticeGivenAt && !hasFixedTerms((tenancy.listing as unknown as { nation?: Nation } | null)?.nation)) {
				await this.tenancyModel.updateOne({ _id: tenancy._id, status: TenancyStatus.ACTIVE }, { $set: { periodic: true, endDate: null } });
				continue;
			}
			const ended = await this.tenancyModel.updateOne({ _id: tenancy._id, status: TenancyStatus.ACTIVE }, { $set: { status: TenancyStatus.ENDED } });
			// A term that ended long before this sweep first ran (e.g. the first deploy) ends quietly: old news is noise.
			if (ended.modifiedCount === 0 || new Date(tenancy.endDate!).getTime() < today.getTime() - 7 * DAY_MS) continue;
			const listing = tenancy.listing as unknown as { propertyTitle?: string; streetAddress?: string } | null;
			const title = listing?.propertyTitle ?? listing?.streetAddress ?? "your home";
			const dedupeKey = `tenancy-ended:${tenancy._id.toString()}`;
			await this.notifications.notifyMany([
				...(tenancy.tenants ?? []).map(tenant => ({
					user: tenant,
					kind: NotificationKind.TENANCY_ENDED,
					title: `Your tenancy at ${title} has ended`,
					body: `${tenancy.noticeGivenAt ? "Your notice period" : "Your fixed term"} is over. Any rent still owed stays on your payments page.`,
					...notificationTarget("student", NotificationTargetKind.TENANCY, tenancy._id),
					dedupeKey
				})),
				{
					user: tenancy.landlord,
					kind: NotificationKind.TENANCY_ENDED,
					title: `The tenancy at ${title} has ended`,
					body: `${tenancy.noticeGivenAt ? "The notice period" : "The fixed term"} is over. Any rent still owed stays on your payments page.`,
					...notificationTarget("landlord", NotificationTargetKind.TENANCY, tenancy._id),
					dedupeKey
				}
			]);
		}
	}

	private async sweepCompliance(now: Date) {
		const horizon = new Date(now.getTime() + 30 * DAY_MS);
		const listings = await this.listingModel
			.find({
				isDraft: { $ne: true },
				$or: [
					{ gasSafetyExpiry: { $lte: horizon } },
					{ eicrExpiry: { $lte: horizon } },
					{ epcExpiry: { $lte: horizon } },
					{ hmoLicenceExpiry: { $lte: horizon } }
				]
			})
			.lean()
			.exec();
		const items = listings.flatMap(listing =>
			listingCompliance(listing as never, now).map(item => ({ item, landlord: listing.landlord }))
		);

		const tenancies = await this.tenancyModel
			// A fixed term past its end date is over (endFinishedTenancies), even if this run could not mark it.
			.find({ status: TenancyStatus.ACTIVE, depositProtectedAt: null, depositAmount: { $gt: 0 }, $nor: [{ periodic: false, endDate: { $lte: londonCalendarDay(now) } }] })
			.populate({ path: "listing", select: "propertyTitle streetAddress nation" })
			.lean()
			.exec();
		for (const tenancy of tenancies) {
			for (const item of tenancyCompliance(tenancy as never, tenancy.listing as never, now)) {
				items.push({ item, landlord: tenancy.landlord });
			}
		}

		for (const { item, landlord } of items) {
			// These two kinds are due "now": a date in the key would re-notify every day.
			const day = item.kind === "LISTING_DEPOSIT_OVER_CAP" || item.kind === "HOLDING_DEPOSIT_OVER_CAP" ? "" : item.dueDate.toISOString().slice(0, 10);
			await this.notifications.notify(
				{
					user: landlord,
					kind: NotificationKind.COMPLIANCE_DUE,
					title: `${item.listingTitle ?? "A property"}: ${item.message}`,
					...notificationTarget("landlord", NotificationTargetKind.COMPLIANCE),
					dedupeKey: `compliance:${item.listing}:${item.kind}:${day}:${item.severity}`
				},
				"complianceDue"
			);
		}
	}

	private async payWithStripe(payment: PaymentLean) {
		const previous = this.stripeFor(payment);
		try {
			// Inside the try: a Stripe outage is "try again" (503), not CARD_NOT_READY.
			const account = await this.accountFor(new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!), payment.landlord);
			// An open Checkout page could still be paid (on its own account): close it first, or let it settle the payment.
			if (payment.providerRef?.startsWith("cs_")) {
				const session = await unlessGone(previous.retrieveCheckoutSession(payment.providerRef), checkoutLapsed(payment));
				if (session?.status === "open") await unlessGone(previous.expireCheckoutSession(session.id));
				else if (session && session.status !== "expired") {
					const settled = await this.completeCheckout(session, payment.stripeAccountId ?? null);
					return this.payResponse(settled ?? payment, null);
				}
			}
			const existing = payment.providerRef?.startsWith("pi_") && payment.provider === PaymentProvider.STRIPE
				? await unlessGone(previous.retrievePaymentIntent(payment.providerRef))
				: null;
			if (existing) {
				if (existing.status === "succeeded") {
					const paid = await this.markPaid(payment, PaymentProvider.STRIPE, existing.id);
					return this.payResponse(paid ?? payment, null);
				}
				// An open intent on another account (Seek's, for a legacy one) is cancelled, never reused.
				if (OPEN_INTENT_STATUSES.includes(existing.status) && (!account || payment.stripeAccountId !== account)) {
					await unlessGone(previous.cancelPaymentIntent(existing.id));
				} else if (OPEN_INTENT_STATUSES.includes(existing.status)) {
					await this.paymentModel.updateOne(
						{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
						{ $set: { status: PaymentStatus.PENDING } }
					);
					return this.payResponse({ ...payment, status: PaymentStatus.PENDING }, existing.client_secret);
				}
			}
			if (!PAYABLE.includes(payment.status) && payment.status !== PaymentStatus.PENDING) {
				throw new BadRequestException("This payment cannot be paid.");
			}
			// Seek never collects rent itself: no landlord account able to take cards, no card payment.
			if (!account) throw new BadRequestException(CARD_NOT_READY);

			await this.bindAccount(payment, account);
			const intent = await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!, account).createPaymentIntent(
				{
					amount: payment.amount,
					currency: "gbp",
					automatic_payment_methods: { enabled: true },
					...seekFeeParams(feeFor(payment).seekFee),
					description: await this.describe(payment),
					metadata: this.stripeMetadata(payment)
				},
				`seek-rent-${payment._id.toString()}-${payment.providerRef ?? "first"}`
			);
			await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
				{ $set: { status: PaymentStatus.PENDING, provider: PaymentProvider.STRIPE, providerRef: intent.id } }
			);
			return this.payResponse({ ...payment, status: PaymentStatus.PENDING, stripeAccountId: account }, intent.client_secret);
		} catch (error) {
			if (error instanceof StripeApiError) {
				this.logger.error(`Stripe error ${error.status} for payment ${payment._id.toString()}: ${error.message}`);
				throw new ServiceUnavailableException("The card payment could not be started. Please try again.");
			}
			throw error;
		}
	}

	/** Marks a payment paid exactly once and sends receipts. */
	private async markPaid(payment: PaymentLean, provider: PaymentProvider, providerRef: string) {
		const paid = await this.paymentModel
			.findOneAndUpdate(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
				// The fee is fixed when the money is collected (Seek keeps 1% of rent actually collected).
				{ $set: { status: PaymentStatus.PAID, paidAt: new Date(), provider, providerRef, ...feeFor({ ...payment, status: undefined }) } },
				{ new: true }
			)
			.lean()
			.exec();
		if (!paid) return null;

		const holding = paid.kind === PaymentKind.HOLDING_DEPOSIT;
		if (paid.refundDue && paid.autoRefund) {
			const accepted = await refundPayment(this.paymentModel, paid as PaymentLean, this.config.get<string>("STRIPE_SECRET_KEY"), paid.refundAmount || paid.amount);
			await notifyHoldingRefund(this.notifications, this.paymentModel, paid as PaymentLean, accepted);
			// Fully refunded: no receipt or "you receive" notice for money going straight back.
			if ((paid.refundAmount || paid.amount) >= paid.amount) return paid as PaymentLean;
		}
		if (holding && paid.application && !paid.refundDue) {
			// Paid after the offer was accepted: the rent schedule was built without this credit.
			const tenancy = await this.tenancyModel
				.findOne({ application: paid.application }, { landlord: 1, tenants: 1, startDate: 1, endDate: 1, monthlyRent: 1, application: 1 })
				.lean()
				.exec();
			if (tenancy) await this.rentSchedule.applyHoldingCredit(tenancy, paid.tenant);
		}
		const plan = holding
			? null
			: await this.planModel
				.findOne({ tenancy: paid.tenancy, tenant: paid.tenant }, { notifyEveryPayment: 1 })
				.lean()
				.exec();
		const tenant = await this.userModel.findById(paid.tenant, { name: 1, email: 1 }).lean().exec();
		if (plan?.notifyEveryPayment !== false) {
			const receiptTitle = `Receipt: ${formatPence(paid.amount)} ${holding ? "holding deposit" : "rent"} paid`;
			const stored = await this.notifications.notify(
				{
					user: paid.tenant,
					kind: NotificationKind.RENT_RECEIPT,
					title: receiptTitle,
					body: holding
						? "Your holding deposit is paid. Your landlord has been notified."
						: `Rent due ${formatDay(paid.dueDate)} is paid. Your landlord has been notified.`,
					// No tenancy yet when a holding deposit is paid: the rent tab would say "No tenancy yet".
					...notificationTarget("student", holding ? NotificationTargetKind.APPLICATION : NotificationTargetKind.PAYMENTS),
					dedupeKey: `receipt:${paid._id.toString()}`
				},
				"receiptEveryPayment"
			);
			// notify() is false when the pref (or the plan) skipped the receipt: no email then either.
			if (stored && this.mail && tenant?.email) {
				const emailBody = holding
					? `Your payment of ${formatPence(paid.amount)} for your holding deposit went through and was sent to your landlord.`
					: `Your payment of ${formatPence(paid.amount)} for your rent due ${formatDay(paid.dueDate)} went through and was sent to your landlord.`;
				const { link } = notificationTarget("student", holding ? NotificationTargetKind.APPLICATION : NotificationTargetKind.PAYMENTS);
				await this.mail.sendPaymentReceiptEmail(tenant.email, tenant.name ?? "there", receiptTitle, emailBody, link).catch(error =>
					this.logger.warn(`Payment receipt email to ${paid.tenant.toString()} failed: ${(error as Error).message}`)
				);
			}
		}
		await this.notifications.notify(
			{
				user: paid.landlord,
				kind: NotificationKind.PAYMENT_RECEIVED,
				title: `${tenant?.name ?? "A tenant"} paid ${formatPence(paid.amount)}${holding ? " holding deposit" : ""}`,
				body: `You receive ${formatPence(paid.payout)} after Seek's ${formatPence(paid.seekFee)} fee.`,
				...notificationTarget("landlord", NotificationTargetKind.PAYMENTS),
				dedupeKey: `received:${paid._id.toString()}`
			},
			"landlordEveryPayment"
		);
		return paid as PaymentLean;
	}

	private payResponse(payment: Pick<PaymentLean, "_id" | "status" | "provider"> & Partial<Pick<PaymentLean, "stripeAccountId">>, clientSecret: string | null) {
		return {
			paymentId: payment._id.toString(),
			status: payment.status,
			provider: payment.provider ?? (this.mode() === "stripe" ? PaymentProvider.STRIPE : PaymentProvider.SIMULATED),
			clientSecret,
			stripeAccountId: payment.stripeAccountId ?? null
		};
	}

	private async findPayment(paymentId: string): Promise<PaymentLean> {
		if (!Types.ObjectId.isValid(paymentId)) throw new BadRequestException("Invalid payment id.");
		const payment = await this.paymentModel.findById(paymentId).lean().exec();
		if (!payment) throw new NotFoundException("Payment not found.");
		return payment as PaymentLean;
	}
}

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
 * Rent reaches the landlord as a destination charge / transfer: that needs the
 * `transfers` capability (v2 recipient `stripe_transfers`), not `charges_enabled`,
 * which stays false on recipient-only accounts.
 */
const canReceive = (account: StripeAccount) => account.capabilities?.transfers === "active";
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
import { TenanciesService } from "../tenancies/tenancies.service";
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

/** Route the charge to the landlord's connected account; Seek's fee only when there is one (none on holding deposits). */
function toLandlord(destination: string | null | undefined, seekFee: number) {
	if (!destination) return {};
	return { ...(seekFee > 0 ? { application_fee_amount: seekFee } : {}), transfer_data: { destination } };
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
		const upcoming = await this.paymentModel
			.find({
				tenancy: tenancy._id,
				tenant: tenant._id,
				status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.LATE, PaymentStatus.FAILED, PaymentStatus.PENDING] }
			})
			.sort({ dueDate: 1 })
			.limit(3)
			.lean()
			.exec();
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
			nation: listing?.nation ?? "ENGLAND",
			allowedFrequencies: allowedFrequencies(listing?.nation, listing?.paymentPlans ?? null),
			restrictionReason: restrictionReason(listing?.nation),
			mode: this.mode(),
			// Same card condition sweepStripeAutopay charges on; the id itself stays server-side.
			autopayCardSaved: plan ? Boolean(await this.planModel.exists({ _id: plan._id, paymentMethodId: { $nin: [null, ""] } })) : false,
			upcoming: upcoming.map(forTenant)
		};
	}

	async updatePlan(tenancyId: string, dto: UpdateRentPlanDto, tenant: Viewer) {
		const tenancy = await this.tenancies.findForTenant(tenancyId, tenant);
		if (tenancy.status !== TenancyStatus.ACTIVE) {
			throw new BadRequestException(
				tenancy.status === TenancyStatus.PENDING_ACCEPTANCE
					? "Rent starts once every housemate has accepted the tenancy."
					: "This tenancy has ended."
			);
		}
		const before = await this.planModel
			.findOne({ tenancy: tenancy._id, tenant: tenant._id })
			.lean()
			.exec();
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
		const hasFuture = await this.paymentModel.exists({
			tenancy: tenancy._id,
			tenant: tenantId,
			status: PaymentStatus.SCHEDULED,
			dueDate: { $gte: startOfUtcDay(new Date()) }
		});
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
		const secret = this.config.get<string>("STRIPE_WEBHOOK_SECRET");
		if (!secret) {
			throw new ServiceUnavailableException("Stripe webhooks are not configured.");
		}
		if (!rawBody || !verifyStripeSignature({ payload: rawBody, header: signature, secret })) {
			throw new BadRequestException("Invalid Stripe signature.");
		}

		let event: { type?: string; data?: { object?: StripePaymentIntent } };
		try {
			event = JSON.parse(rawBody.toString("utf8"));
		} catch {
			throw new BadRequestException("Invalid webhook payload.");
		}
		if (event.type === "checkout.session.completed") {
			const sessionId = event.data?.object?.id;
			// The event's payment_intent is a bare id: the retrieved session expands it, so the autopay card gets saved.
			if (sessionId && this.mode() === "stripe") {
				await this.completeCheckout(
					await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!).retrieveCheckoutSession(sessionId)
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
		if (typeof intent.amount === "number" && intent.amount !== payment.amount) {
			this.logger.error(`Stripe amount mismatch for payment ${payment._id.toString()}: charged ${intent.amount}, expected ${payment.amount}`);
			// A captured charge Seek can't match is never kept silently: it goes back to the payer.
			if (event.type === "payment_intent.succeeded") await this.refundCharge(intent.id, "requested_by_customer");
			return { received: true };
		}

		if (event.type === "payment_intent.succeeded") {
			const paid = await this.markPaid(payment as PaymentLean, PaymentProvider.STRIPE, intent.id);
			if (!paid) await this.refundIfDuplicate(payment._id, intent.id);
		} else if (event.type === "payment_intent.payment_failed") {
			// A declined card on Checkout is retried on the same page: its session stays the reference.
			if (payment.providerRef?.startsWith("cs_")) return { received: true };
			const failed = await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID }, providerRef: intent.id },
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
		const payments = await this.paymentModel
			.find({
				landlord: new Types.ObjectId(landlordId),
				dueDate: { $gte: range.start, $lt: range.end }
			})
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

		const plans = await this.planModel
			.find({ tenancy: { $in: payments.map(p => (p.tenancy as unknown as { _id: Types.ObjectId })?._id ?? p.tenancy) } })
			.lean()
			.exec();
		const planFor = new Map(plans.map(plan => [`${plan.tenancy.toString()}:${plan.tenant.toString()}`, plan]));

		const payoutsOnHold = await this.payoutsOnHold(landlordId);
		const totals = { collected: 0, expected: 0, late: 0, lateAmount: 0, seekFee: 0, payouts: 0, held: 0, holdingDepositsCollected: 0, holdingDepositsExpected: 0 };
		const rows = payments.map(payment => {
			// Rent totals match /landlord/overview; holding deposits are counted on their own.
			const isHolding = payment.kind === PaymentKind.HOLDING_DEPOSIT;
			const paid = payment.status === PaymentStatus.PAID;
			if (isHolding) {
				totals.holdingDepositsExpected += payment.amount;
				if (paid) totals.holdingDepositsCollected += payment.amount;
			} else {
				totals.expected += payment.amount;
				if (paid) totals.collected += payment.amount;
			}
			const held = payment.payoutStatus === PayoutStatus.HELD;
			if (paid) {
				totals.seekFee += payment.seekFee;
				if (held) totals.held += payment.payout;
				else totals.payouts += payment.payout;
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
			return {
				payment: payment._id.toString(),
				kind: payment.kind ?? PaymentKind.RENT,
				tenancy: tenancy?._id?.toString() ?? (payment.tenancy ? String(payment.tenancy) : null),
				property: listing?.propertyTitle ?? listing?.streetAddress ?? null,
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
				refundDue: payment.refundDue ?? false,
				// Rows still to collect show today's 1%, not the rate when they were scheduled.
				fee: feeFor(payment).seekFee,
				payout: feeFor(payment).payout,
				holdingDepositCredit: payment.holdingDepositCredit ?? 0,
				payoutStatus: payment.payoutStatus ?? null,
				nextPayout: payoutsOnHold || held
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
			nextPayoutDate: payoutsOnHold ? null : await this.nextPayoutDate(landlordId),
			rows
		};
	}

	/** Card payments can't reach this landlord yet: no Stripe account able to take charges. */
	private async payoutsOnHold(landlordId: string): Promise<boolean> {
		if (this.mode() !== "stripe") return false;
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		return !(await this.destinationFor(stripe, new Types.ObjectId(landlordId)));
	}

	/**
	 * Money Seek collected while a landlord had no payout account goes to them,
	 * minus Seek's fee, once their account can take charges. Runs in the hourly
	 * sweep and when connect status turns ready; a failed transfer retries next run.
	 */
	async releaseHeldPayouts(landlordId?: Types.ObjectId): Promise<number> {
		if (this.mode() !== "stripe") return 0;
		const held = (await this.paymentModel
			// A deposit owed back to the student stays with Seek until it's refunded.
			.find({ status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, refundDue: { $ne: true }, ...(landlordId ? { landlord: landlordId } : {}) })
			.lean()
			.exec()) as PaymentLean[];
		if (held.length === 0) return 0;
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		const destinations = new Map<string, string | null>();
		let released = 0;
		for (const payment of held) {
			const key = payment.landlord.toString();
			if (!destinations.has(key)) destinations.set(key, await this.destinationFor(stripe, payment.landlord));
			const destination = destinations.get(key);
			if (!destination) continue;
			try {
				const charge = await this.chargeFor(stripe, payment.providerRef);
				const transfer = await stripe.createTransfer(
					{
						amount: payment.amount - payment.seekFee,
						currency: "gbp",
						destination,
						// Tied to the original charge, so it doesn't wait for Seek's balance to clear.
						...(charge ? { source_transaction: charge } : {}),
						metadata: this.stripeMetadata(payment)
					},
					`seek-release-${payment._id.toString()}`
				);
				await this.paymentModel.updateOne(
					{ _id: payment._id, payoutStatus: PayoutStatus.HELD },
					{ $set: { payoutStatus: PayoutStatus.TRANSFERRED, transferRef: transfer.id } }
				);
				released += 1;
			} catch (error) {
				// Network errors too: the next run retries under the same idempotency key.
				this.logger.warn(`Held payment ${payment._id.toString()} not released yet (${error instanceof StripeApiError ? error.status : "network"}): ${(error as Error).message}`);
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

		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		try {
			if (payment.providerRef?.startsWith("cs_")) {
				const existing = await stripe.retrieveCheckoutSession(payment.providerRef);
				if (existing.status === "open" && existing.url) {
					if (existing.success_url === successUrl && existing.cancel_url === cancelUrl) {
						return { mode, sessionId: existing.id, url: existing.url, status: payment.status };
					}
					// Opened from the other client (web vs app): it would send the payer back to the wrong place.
					await stripe.expireCheckoutSession(existing.id);
				}
				if (existing.payment_status === "paid") {
					const done = await this.completeCheckout(existing);
					return { mode, sessionId: existing.id, url: successUrl.replace("{CHECKOUT_SESSION_ID}", existing.id), status: done?.status ?? payment.status };
				}
			}
			const plan = payment.tenancy
				? await this.planModel.findOne({ tenancy: payment.tenancy, tenant: payment.tenant }, { autopay: 1 }).lean().exec()
				: null;
			const saveCard = Boolean(plan?.autopay) && payment.kind !== PaymentKind.HOLDING_DEPOSIT;
			const destination = await this.destinationFor(stripe, payment.landlord);
			const customer = await this.customerFor(stripe, payment.tenant);
			// A holding deposit's session closes with its offer. Stripe allows 30 minutes to 24 hours;
			// whole minutes keep the idempotency key stable across a double tap.
			const closesAt = offerEnds
				? Math.floor(Math.min(Math.max(offerEnds.getTime(), Date.now() + 31 * 60_000), Date.now() + 23 * 3_600_000) / 60_000) * 60
				: null;
			const body = {
					mode: "payment",
					customer,
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
						...toLandlord(destination, feeFor(payment).seekFee),
						...(saveCard ? { setup_future_usage: "off_session" } : {}),
						metadata: this.stripeMetadata(payment)
					},
					metadata: this.stripeMetadata(payment),
					...(closesAt ? { expires_at: closesAt } : {}),
					success_url: successUrl,
					cancel_url: cancelUrl
				};
			// Keyed on the whole request: a changed amount, customer, destination or autopay choice is a new session.
			const session = await stripe.createCheckoutSession(
				body,
				`seek-checkout-${payment._id.toString()}-${payment.providerRef ?? "first"}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`
			);
			// Remember the session so a second tap reuses it instead of opening a second charge.
			await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
				{ $set: { provider: PaymentProvider.STRIPE, providerRef: session.id, payoutStatus: destination ? null : PayoutStatus.HELD } }
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
		let session: StripeCheckoutSession;
		try {
			session = await new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!).retrieveCheckoutSession(sessionId);
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
		const updated = await this.completeCheckout(session);
		return this.payResponse(updated ?? (await this.findPayment(paymentId)), null);
	}

	/** Shared by the redirect confirm and the checkout.session.completed webhook. */
	private async completeCheckout(session: StripeCheckoutSession | undefined) {
		const paymentId = session?.metadata?.paymentId;
		if (!session?.id || !paymentId || !Types.ObjectId.isValid(paymentId)) return null;
		const payment = await this.paymentModel.findById(paymentId).lean().exec();
		if (!payment) {
			this.logger.warn(`Checkout session ${session.id} for unknown payment`);
			return null;
		}
		const intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
		const intentId = typeof session.payment_intent === "string" ? session.payment_intent : intent?.id;
		if (typeof session.amount_total === "number" && session.amount_total !== payment.amount) {
			this.logger.error(`Stripe amount mismatch for payment ${payment._id.toString()} (session ${session.id}): charged ${session.amount_total}, expected ${payment.amount}`);
			if (session.payment_status === "paid" && intentId) await this.refundCharge(intentId, "requested_by_customer");
			return null;
		}
		if (session.payment_status !== "paid") return payment as PaymentLean;

		const paid = await this.markPaid(payment as PaymentLean, PaymentProvider.STRIPE, intentId ?? session.id);
		if (!paid && intentId) await this.refundIfDuplicate(payment._id, intentId, session.id);
		if (session.customer) {
			await this.userModel.updateOne(
				{ _id: payment.tenant, stripeCustomerId: { $exists: false } },
				{ $set: { stripeCustomerId: session.customer } }
			);
		}
		if (intent?.payment_method && payment.tenancy) {
			await this.planModel.updateOne(
				{ tenancy: payment.tenancy, tenant: payment.tenant, autopay: true },
				{ $set: { paymentMethodId: intent.payment_method } }
			);
		}
		return paid ?? (payment as PaymentLean);
	}

	/**
	 * A second successful charge on an already-paid payment (autopay and an open
	 * Checkout, say) is refunded, never kept. Same charge seen twice: nothing.
	 */
	private async refundIfDuplicate(paymentId: Types.ObjectId, intentId: string, sessionId?: string) {
		const current = await this.paymentModel.findById(paymentId, { status: 1, providerRef: 1 }).lean().exec();
		if (current?.status !== PaymentStatus.PAID || current.providerRef === intentId || (sessionId && current.providerRef === sessionId)) return;
		this.logger.error(`Duplicate charge ${intentId} on payment ${paymentId.toString()} already paid by ${current.providerRef}: refunding it`);
		await this.refundCharge(intentId, "duplicate");
	}

	/** Refunds a whole charge, idempotently per intent. */
	private async refundCharge(intentId: string, reason: "duplicate" | "requested_by_customer") {
		try {
			const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
			const intent = await stripe.retrievePaymentIntent(intentId);
			await stripe.createRefund(
				{
					payment_intent: intentId,
					reason,
					// A destination charge already went to the landlord: take it back from them, with Seek's fee.
					...(intent.transfer_data ? { reverse_transfer: true } : {}),
					...(intent.application_fee_amount ? { refund_application_fee: true } : {})
				},
				`seek-refund-${intentId}`
			);
		} catch (error) {
			if (!(error instanceof StripeApiError)) throw error;
			this.logger.error(`Refund of charge ${intentId} failed (${error.status}): ${error.message}. Refund it in the Stripe dashboard.`);
		}
	}

	/** The landlord's connected account, when Stripe lets it receive destination charges and transfers. */
	private async destinationFor(stripe: StripeClient, landlordId: Types.ObjectId): Promise<string | null> {
		const landlord = await this.userModel.findById(landlordId, { stripeAccountId: 1 }).lean().exec();
		const accountId = landlord?.stripeAccountId;
		if (!accountId || accountId.startsWith("acct_sim_")) return null;
		try {
			const account = await stripe.retrieveAccount(accountId);
			return canReceive(account) ? accountId : null;
		} catch (error) {
			if (error instanceof StripeApiError) return null;
			throw error;
		}
	}

	private async customerFor(stripe: StripeClient, tenantId: Types.ObjectId): Promise<string> {
		const user = await this.userModel.findById(tenantId, { stripeCustomerId: 1, email: 1, name: 1 }).lean().exec();
		if (user?.stripeCustomerId) return user.stripeCustomerId;
		const customer = await stripe.createCustomer(
			{ email: user?.email, name: user?.name, metadata: { userId: tenantId.toString() } },
			`seek-customer-${tenantId.toString()}`
		);
		await this.userModel.updateOne({ _id: tenantId }, { $set: { stripeCustomerId: customer.id } });
		return customer.id;
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
	 * Creates the landlord's Stripe connected account (Accounts v2, recipient) the first time and returns
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
		try {
			let accountId = user.stripeAccountId;
			if (!accountId) {
				const account = await stripe.createRecipientAccount(
					{
						...(user.email ? { contact_email: user.email } : {}),
						metadata: { userId: landlord._id.toString() }
					},
					`seek-connect-${landlord._id.toString()}`
				);
				accountId = account.id;
				await this.userModel.updateOne({ _id: landlord._id }, { $set: { stripeAccountId: accountId } }).exec();
			}
			const frontend = this.config.get<string>("FRONTEND_URL") ?? "";
			const link = await stripe.createAccountLink({
				account: accountId,
				return_url: this.config.get<string>("STRIPE_CONNECT_RETURN_URL") || `${frontend}/landlord/payments?connect=return`,
				refresh_url: this.config.get<string>("STRIPE_CONNECT_REFRESH_URL") || `${frontend}/landlord/payments?connect=refresh`
			});
			return { mode: "stripe", accountId, url: link.url };
		} catch (error) {
			if (error instanceof StripeApiError) {
				this.logger.error(`Stripe Connect onboarding failed (${error.status} ${error.code ?? "no code"}): ${error.message}`);
				if (CONNECT_NOT_ENABLED.has(error.code ?? "") || /signed up for Connect/i.test(error.message)) {
					throw new ConflictException(
						"Payouts to your bank aren't available yet: Stripe Connect is not enabled for Seek. Tenants can still pay by card and Seek holds the rent until payouts are switched on."
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
				? { last4: bank.last4 ?? null, bankName: bank.bank_name ?? null, verified: bank.status === "verified" }
				: null;
			await this.userModel.updateOne({ _id: landlordId }, payoutBank ? { $set: { payoutBank } } : { $unset: { payoutBank: 1 } });
			// Payouts just became possible: send what Seek held now rather than at the next sweep.
			const ready = canReceive(account);
			if (ready) {
				await this.releaseHeldPayouts(new Types.ObjectId(landlordId)).catch((error: Error) =>
					this.logger.error(`Releasing held payouts failed: ${error.message}`)
				);
			}
			return {
				...none,
				payoutBank,
				connected: true,
				chargesEnabled: ready,
				payoutsEnabled: account.payouts_enabled,
				detailsSubmitted: account.details_submitted
			};
		} catch (error) {
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
				status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.FAILED] },
				dueDate: { $lt: today }
			})
			.lean()
			.exec();
		for (const payment of overdue) {
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
				.findOne({ tenancy: payment.tenancy, tenant: payment.tenant }, { autopay: 1 })
				.lean()
				.exec();
			const stage = dueReminderStage({
				status: payment.status,
				dueDate: payment.dueDate,
				today,
				remindDaysBefore: await reminderDaysFor(payment.tenant),
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
				: plan?.autopay ? "Autopay will take it automatically." : "Pay in Seek in a couple of taps.";
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

	/** Charges due instalments off-session with the card saved at Checkout. */
	private async sweepStripeAutopay(now: Date) {
		const plans = await this.planModel
			// Naming the select:false field in the projection includes it.
			.find({ autopay: true, paymentMethodId: { $exists: true } }, { tenancy: 1, tenant: 1, paymentMethodId: 1 })
			.lean()
			.exec();
		if (plans.length === 0) return;
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);
		for (const plan of plans) {
			const tenant = await this.userModel.findById(plan.tenant, { stripeCustomerId: 1 }).lean().exec();
			if (!tenant?.stripeCustomerId || !plan.paymentMethodId) continue;
			const due = await this.paymentModel
				.find({ tenancy: plan.tenancy, tenant: plan.tenant, status: PaymentStatus.SCHEDULED, dueDate: { $lte: now } })
				.lean()
				.exec();
			for (const payment of due as PaymentLean[]) {
				// An open Checkout page could still be paid: close it first, or leave the instalment to it.
				if (payment.providerRef?.startsWith("cs_")) {
					try {
						const session = await stripe.retrieveCheckoutSession(payment.providerRef);
						if (session.status === "open") await stripe.expireCheckoutSession(session.id);
						else if (session.status !== "expired") {
							await this.completeCheckout(session);
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
					const destination = await this.destinationFor(stripe, payment.landlord);
					const intent = await stripe.createPaymentIntent(
						{
							amount: payment.amount,
							currency: "gbp",
							customer: tenant.stripeCustomerId,
							payment_method: plan.paymentMethodId,
							off_session: true,
							confirm: true,
							...toLandlord(destination, feeFor(payment).seekFee),
							description: await this.describe(payment),
							metadata: this.stripeMetadata(payment)
						},
						`seek-autopay-${payment._id.toString()}`
					);
					await this.paymentModel.updateOne(
						{ _id: payment._id },
						{ $set: { providerRef: intent.id, payoutStatus: destination ? null : PayoutStatus.HELD } }
					);
					if (intent.status === "succeeded") await this.markPaid(payment, PaymentProvider.STRIPE, intent.id);
				} catch (error) {
					if (!(error instanceof StripeApiError)) {
						// No answer from Stripe (timeout, network): back to SCHEDULED so the next sweep retries;
						// the seek-autopay idempotency key returns the same intent if this one was created.
						this.logger.error(`Autopay for payment ${payment._id.toString()} got no answer from Stripe, retrying next sweep: ${(error as Error).message}`);
						await this.paymentModel.updateOne(
							{ _id: payment._id, status: PaymentStatus.PENDING },
							{ $set: { status: PaymentStatus.SCHEDULED } }
						);
						continue;
					}
					this.logger.warn(`Autopay failed for payment ${payment._id.toString()} (${error.status})`);
					await this.paymentModel.updateOne(
						{ _id: payment._id, status: PaymentStatus.PENDING },
						{ $set: { status: PaymentStatus.FAILED } }
					);
					await this.notifications.notify({
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

	private async sweepCompliance(now: Date) {
		const horizon = new Date(now.getTime() + 30 * DAY_MS);
		const listings = await this.listingModel
			.find({
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
			.find({ status: TenancyStatus.ACTIVE, depositProtectedAt: null, depositAmount: { $gt: 0 } })
			.populate({ path: "listing", select: "propertyTitle streetAddress nation" })
			.lean()
			.exec();
		for (const tenancy of tenancies) {
			for (const item of tenancyCompliance(tenancy as never, tenancy.listing as never, now)) {
				items.push({ item, landlord: tenancy.landlord });
			}
		}

		for (const { item, landlord } of items) {
			await this.notifications.notify(
				{
					user: landlord,
					kind: NotificationKind.COMPLIANCE_DUE,
					title: `${item.listingTitle ?? "A property"}: ${item.message}`,
					...notificationTarget("landlord", NotificationTargetKind.COMPLIANCE),
					dedupeKey: `compliance:${item.listing}:${item.kind}:${item.dueDate.toISOString().slice(0, 10)}:${item.severity}`
				},
				"complianceDue"
			);
		}
	}

	private async payWithStripe(payment: PaymentLean) {
		const stripe = new StripeClient(this.config.get<string>("STRIPE_SECRET_KEY")!);

		try {
			if (payment.providerRef?.startsWith("pi_") && payment.provider === PaymentProvider.STRIPE) {
				const existing = await stripe.retrievePaymentIntent(payment.providerRef);
				if (existing.status === "succeeded") {
					const paid = await this.markPaid(payment, PaymentProvider.STRIPE, existing.id);
					return this.payResponse(paid ?? payment, null);
				}
				if (OPEN_INTENT_STATUSES.includes(existing.status)) {
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

			// No usable connected account yet: Seek collects the rent and pays out later.
			const destination = await this.destinationFor(stripe, payment.landlord);
			const intent = await stripe.createPaymentIntent(
				{
					amount: payment.amount,
					currency: "gbp",
					automatic_payment_methods: { enabled: true },
					...toLandlord(destination, feeFor(payment).seekFee),
					description: await this.describe(payment),
					metadata: this.stripeMetadata(payment)
				},
				`seek-rent-${payment._id.toString()}-${payment.providerRef ?? "first"}`
			);
			await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $ne: PaymentStatus.PAID } },
				{ $set: { status: PaymentStatus.PENDING, provider: PaymentProvider.STRIPE, providerRef: intent.id, payoutStatus: destination ? null : PayoutStatus.HELD } }
			);
			return this.payResponse({ ...payment, status: PaymentStatus.PENDING }, intent.client_secret);
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
		const plan = holding
			? null
			: await this.planModel
				.findOne({ tenancy: paid.tenancy, tenant: paid.tenant }, { notifyEveryPayment: 1 })
				.lean()
				.exec();
		const tenant = await this.userModel.findById(paid.tenant, { name: 1 }).lean().exec();
		if (plan?.notifyEveryPayment !== false) {
			await this.notifications.notify(
				{
					user: paid.tenant,
					kind: NotificationKind.RENT_RECEIPT,
					title: `Receipt: ${formatPence(paid.amount)} ${holding ? "holding deposit" : "rent"} paid`,
					body: holding
						? "Your holding deposit is paid. Your landlord has been notified."
						: `Rent due ${formatDay(paid.dueDate)} is paid. Your landlord has been notified.`,
					...notificationTarget("student", NotificationTargetKind.PAYMENTS),
					dedupeKey: `receipt:${paid._id.toString()}`
				},
				"receiptEveryPayment"
			);
		}
		await this.notifications.notify(
			{
				user: paid.landlord,
				kind: NotificationKind.PAYMENT_RECEIVED,
				title: `${tenant?.name ?? "A tenant"} paid ${formatPence(paid.amount)}${holding ? " holding deposit" : ""}`,
				body: paid.payoutStatus === PayoutStatus.HELD
					? `Seek is holding ${formatPence(paid.payout)} for you (after its ${formatPence(paid.seekFee)} fee) until you set up payouts.`
					: `You receive ${formatPence(paid.payout)} after Seek's ${formatPence(paid.seekFee)} fee.`,
				...notificationTarget("landlord", NotificationTargetKind.PAYMENTS),
				dedupeKey: `received:${paid._id.toString()}`
			},
			"landlordEveryPayment"
		);
		return paid as PaymentLean;
	}

	private payResponse(payment: Pick<PaymentLean, "_id" | "status" | "provider">, clientSecret: string | null) {
		return {
			paymentId: payment._id.toString(),
			status: payment.status,
			provider: payment.provider ?? (this.mode() === "stripe" ? PaymentProvider.STRIPE : PaymentProvider.SIMULATED),
			clientSecret
		};
	}

	private async findPayment(paymentId: string): Promise<PaymentLean> {
		if (!Types.ObjectId.isValid(paymentId)) throw new BadRequestException("Invalid payment id.");
		const payment = await this.paymentModel.findById(paymentId).lean().exec();
		if (!payment) throw new NotFoundException("Payment not found.");
		return payment as PaymentLean;
	}
}

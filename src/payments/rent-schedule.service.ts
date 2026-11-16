import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Payment } from "./payment.schema";
import { RentPlan } from "./rent-plan.schema";
import { PaymentKind, PaymentStatus, PlanFrequency } from "./payment.enums";
import { addMonths, buildSchedule, computeFee, firstTrackedDate, startOfUtcDay } from "./schedule";

interface TenancyForSchedule {
	_id: Types.ObjectId;
	landlord: Types.ObjectId;
	tenants: Types.ObjectId[];
	startDate: Date;
	endDate?: Date | null;
	monthlyRent: number;
	/** Set when the tenancy came from an application: its paid holding deposits count toward rent. */
	application?: Types.ObjectId | null;
}

/**
 * Owns the rent plan and the scheduled payments derived from it. Lives with
 * tenancies so creating a tenancy can schedule rent without a module cycle.
 */
@Injectable()
export class RentScheduleService {
	constructor(
		@InjectModel(RentPlan.name) private readonly planModel: Model<RentPlan>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>
	) {}

	// shortcut: in-process only (one API instance runs the sweeper too); use a DB/Redis lock once there are several instances.
	private readonly queues = new Map<string, Promise<unknown>>();

	/** Runs schedule rewrites for one tenant one at a time: overlapping ones would each insert the whole schedule. */
	private serialized<T>(tenancy: TenancyForSchedule, tenant: Types.ObjectId, work: () => Promise<T>): Promise<T> {
		const key = `${tenancy._id}:${tenant}`;
		const run = (this.queues.get(key) ?? Promise.resolve()).then(work);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(key, tail);
		void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
		return run;
	}

	/** Gives every tenant a monthly plan and a year of scheduled rent. */
	async ensureDefaultPlans(tenancy: TenancyForSchedule, now: Date = new Date()) {
		for (const tenant of tenancy.tenants) {
			const result = await this.planModel.updateOne(
				{ tenancy: tenancy._id, tenant },
				{
					$setOnInsert: {
						tenancy: tenancy._id,
						tenant,
						frequency: PlanFrequency.MONTHLY,
						autopay: false,
						notifyEveryPayment: true,
						remindDaysBefore: 3
					}
				},
				{ upsert: true }
			);
			if (result.upsertedCount > 0) {
				await this.regenerate(tenancy, tenant, PlanFrequency.MONTHLY, now);
			}
		}
	}

	/**
	 * Replaces future SCHEDULED payments with ones for the new frequency.
	 * Paid, pending, failed and late payments stay, and so does every unpaid
	 * instalment before the last of them; new instalments start after the
	 * last period covered. A tenant with no payments yet starts
	 * from the tenancy start date, or from this month when it began earlier
	 * (earlier months are not back-filled), so the current month's rent exists.
	 * An instalment whose due date has already passed is created as LATE.
	 */
	regenerate(tenancy: TenancyForSchedule, tenant: Types.ObjectId, frequency: PlanFrequency, now: Date = new Date()) {
		return this.serialized(tenancy, tenant, () => this.rewrite(tenancy, tenant, frequency, now));
	}

	private async rewrite(tenancy: TenancyForSchedule, tenant: Types.ObjectId, frequency: PlanFrequency, now: Date) {
		const today = startOfUtcDay(now);
		// Unpaid months before a kept instalment (opened or paid early) stay as they are, or they would never be billed.
		const lastKept = await this.paymentModel
			.findOne({
				tenancy: tenancy._id,
				tenant,
				$or: [{ status: { $ne: PaymentStatus.SCHEDULED } }, { dueDate: { $lt: today } }, { providerRef: /^cs_/ }]
			})
			.sort({ dueDate: -1 })
			.lean()
			.exec();
		await this.paymentModel.deleteMany({
			tenancy: tenancy._id,
			tenant,
			status: PaymentStatus.SCHEDULED,
			// An instalment with a Checkout session open can still be paid: keep it, the new plan starts after it.
			providerRef: { $not: /^cs_/ },
			// Only rows the autopay sweep (dueDate <= now) can't have tried yet: a retried one must keep its _id, its Stripe idempotency key.
			dueDate: { $gt: new Date(Math.max(now.getTime(), lastKept ? new Date(lastKept.dueDate).getTime() : 0)) }
		});

		const latest = await this.paymentModel
			.findOne({ tenancy: tenancy._id, tenant })
			.sort({ dueDate: -1 })
			.lean()
			.exec();
		const from = latest
			? new Date(Math.max(
				today.getTime(),
				addMonths(new Date(latest.dueDate), latest.coversMonths ?? 1).getTime()
			))
			: firstTrackedDate(new Date(tenancy.startDate), today);

		const instalments = buildSchedule({
			startDate: new Date(tenancy.startDate),
			endDate: tenancy.endDate ? new Date(tenancy.endDate) : null,
			monthlyRent: tenancy.monthlyRent,
			frequency,
			from
		});
		return this.insert(tenancy, tenant, instalments, today);
	}

	/**
	 * Hourly top-up so rent keeps running a year ahead (periodic and long
	 * tenancies outlive the first 12 months). Only appends after the last
	 * period already covered; existing rows are never touched.
	 */
	extend(tenancy: TenancyForSchedule, tenant: Types.ObjectId, frequency: PlanFrequency, now: Date = new Date()) {
		return this.serialized(tenancy, tenant, () => this.append(tenancy, tenant, frequency, now));
	}

	private async append(tenancy: TenancyForSchedule, tenant: Types.ObjectId, frequency: PlanFrequency, now: Date) {
		const today = startOfUtcDay(now);
		const latest = await this.paymentModel
			.findOne({ tenancy: tenancy._id, tenant })
			.sort({ dueDate: -1 })
			.lean()
			.exec();
		// No rows yet: ensureDefaultPlans / updatePlan build the first schedule.
		if (!latest) return [];
		const horizon = addMonths(today, 12);
		const from = new Date(Math.max(
			today.getTime(),
			addMonths(new Date(latest.dueDate), latest.coversMonths ?? 1).getTime()
		));
		if (from >= horizon) return [];
		const instalments = buildSchedule({
			startDate: new Date(tenancy.startDate),
			endDate: tenancy.endDate ? new Date(tenancy.endDate) : null,
			monthlyRent: tenancy.monthlyRent,
			frequency,
			from
		}).filter(instalment => instalment.dueDate < horizon);
		return this.insert(tenancy, tenant, instalments, today);
	}

	/**
	 * Puts a holding deposit that was paid after the schedule was built (late webhook) toward the
	 * next unpaid rent. Only rows no payment was started on and autopay can't have tried yet.
	 */
	applyHoldingCredit(tenancy: TenancyForSchedule, tenant: Types.ObjectId, now: Date = new Date()) {
		return this.serialized(tenancy, tenant, async () => {
			let credit = await this.unusedHoldingCredit(tenancy, tenant);
			if (credit === 0) return;
			const rows = await this.paymentModel
				.find({ tenancy: tenancy._id, tenant, kind: { $ne: PaymentKind.HOLDING_DEPOSIT }, status: PaymentStatus.SCHEDULED, providerRef: null, dueDate: { $gt: now } })
				.sort({ dueDate: 1 })
				.lean()
				.exec();
			for (const row of rows) {
				if (credit === 0) break;
				const applied = Math.min(credit, row.amount);
				const amount = row.amount - applied;
				const result = await this.paymentModel.updateOne(
					{ _id: row._id, status: PaymentStatus.SCHEDULED, providerRef: null, amount: row.amount },
					{ $set: { amount, ...computeFee(amount), holdingDepositCredit: (row.holdingDepositCredit ?? 0) + applied } }
				);
				if (result.modifiedCount > 0) credit -= applied;
			}
		});
	}

	private async insert(
		tenancy: TenancyForSchedule,
		tenant: Types.ObjectId,
		instalments: ReturnType<typeof buildSchedule>,
		today: Date
	) {
		if (instalments.length === 0) return [];

		// Tenant Fees Act: a paid holding deposit goes towards the first rent.
		let credit = await this.unusedHoldingCredit(tenancy, tenant);
		const rows = instalments.map(instalment => {
			const applied = Math.min(credit, instalment.amount);
			credit -= applied;
			if (applied === 0) return instalment;
			const amount = instalment.amount - applied;
			return { ...instalment, amount, ...computeFee(amount), holdingDepositCredit: applied };
		});

		return this.paymentModel.insertMany(
			rows.map(instalment => ({
				tenancy: tenancy._id,
				tenant,
				landlord: tenancy.landlord,
				status: instalment.dueDate < today ? PaymentStatus.LATE : PaymentStatus.SCHEDULED,
				...instalment
			}))
		);
	}

	/** The tenant's paid holding deposits for this tenancy's application, less what rent rows already absorbed. */
	private async unusedHoldingCredit(tenancy: TenancyForSchedule, tenant: Types.ObjectId): Promise<number> {
		if (!tenancy.application) return 0;
		const [paid, applied] = await Promise.all([
			this.paymentModel
				.find({ application: tenancy.application, tenant, kind: PaymentKind.HOLDING_DEPOSIT, status: PaymentStatus.PAID, refundDue: { $ne: true } }, { amount: 1 })
				.lean()
				.exec(),
			this.paymentModel
				.find({ tenancy: tenancy._id, tenant, holdingDepositCredit: { $gt: 0 } }, { holdingDepositCredit: 1 })
				.lean()
				.exec()
		]);
		const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
		return Math.max(0, sum(paid.map(row => row.amount)) - sum(applied.map(row => row.holdingDepositCredit ?? 0)));
	}
}

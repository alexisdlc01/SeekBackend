import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Payment } from "./payment.schema";
import { RentPlan } from "./rent-plan.schema";
import { PaymentStatus, PlanFrequency } from "./payment.enums";
import { addMonths, buildSchedule, firstTrackedDate, startOfUtcDay } from "./schedule";

interface TenancyForSchedule {
	_id: Types.ObjectId;
	landlord: Types.ObjectId;
	tenants: Types.ObjectId[];
	startDate: Date;
	endDate?: Date | null;
	monthlyRent: number;
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
	 * Paid, pending, failed and late payments stay; new instalments start
	 * after the last period they cover. A tenant with no payments yet starts
	 * from the tenancy start date, or from this month when it began earlier
	 * (earlier months are not back-filled), so the current month's rent exists.
	 * An instalment whose due date has already passed is created as LATE.
	 */
	async regenerate(
		tenancy: TenancyForSchedule,
		tenant: Types.ObjectId,
		frequency: PlanFrequency,
		now: Date = new Date()
	) {
		const today = startOfUtcDay(now);
		await this.paymentModel.deleteMany({
			tenancy: tenancy._id,
			tenant,
			status: PaymentStatus.SCHEDULED,
			dueDate: { $gte: today },
			// An instalment with a Checkout session open can still be paid: keep it, the new plan starts after it.
			providerRef: { $not: /^cs_/ }
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
		if (instalments.length === 0) return [];

		return this.paymentModel.insertMany(
			instalments.map(instalment => ({
				tenancy: tenancy._id,
				tenant,
				landlord: tenancy.landlord,
				status: instalment.dueDate < today ? PaymentStatus.LATE : PaymentStatus.SCHEDULED,
				...instalment
			}))
		);
	}
}

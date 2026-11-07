import { BadRequestException } from "@nestjs/common";
import { Nation } from "../listings/enums/nation.enum";
import { PlanFrequency } from "./payment.enums";

/** Seek keeps 0.5% of each rent payment, rounded to the nearest penny. */
export const SEEK_FEE_RATE = 0.005;

export function computeFee(amountPence: number): { seekFee: number; payout: number } {
	const seekFee = Math.round(amountPence * SEEK_FEE_RATE);
	return { seekFee, payout: amountPence - seekFee };
}

export const FREQUENCY_MONTHS: Record<PlanFrequency, number> = {
	[PlanFrequency.MONTHLY]: 1,
	[PlanFrequency.SIX_MONTHS]: 6,
	[PlanFrequency.YEARLY]: 12
};

export const ENGLAND_RENT_IN_ADVANCE_MESSAGE =
	"Renters' Rights Act: rent in advance is capped at one month for properties in England. Choose a monthly plan.";

/** Frequencies a tenant may choose for a property in this nation. */
export function allowedFrequencies(nation: Nation | string | undefined): PlanFrequency[] {
	// Listings saved before nations existed are English by default.
	if (!nation || nation === Nation.ENGLAND) return [PlanFrequency.MONTHLY];
	return Object.values(PlanFrequency);
}

export function restrictionReason(nation: Nation | string | undefined): string | null {
	return allowedFrequencies(nation).length === 1 ? ENGLAND_RENT_IN_ADVANCE_MESSAGE : null;
}

export function assertPlanAllowed(
	nation: Nation | string | undefined,
	frequency: PlanFrequency
): void {
	if (!allowedFrequencies(nation).includes(frequency)) {
		throw new BadRequestException(ENGLAND_RENT_IN_ADVANCE_MESSAGE);
	}
}

/** Same day of month as the anchor, clamped to short months (31 Jan → 28 Feb). */
export function addMonths(anchor: Date, months: number): Date {
	const year = anchor.getUTCFullYear();
	const month = anchor.getUTCMonth() + months;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(Date.UTC(
		year,
		month,
		Math.min(anchor.getUTCDate(), lastDay),
		anchor.getUTCHours(),
		anchor.getUTCMinutes()
	));
}

export function startOfUtcDay(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface ScheduledInstalment {
	dueDate: Date;
	amount: number;
	coversMonths: number;
	seekFee: number;
	payout: number;
}

/**
 * Rent instalments for one tenant from `from` (inclusive) for `horizonMonths`.
 * Due dates follow the tenancy start date; each instalment covers
 * `frequency` months, shortened when the tenancy ends sooner.
 */
export function buildSchedule(params: {
	startDate: Date;
	endDate?: Date | null;
	monthlyRent: number;
	frequency: PlanFrequency;
	from: Date;
	horizonMonths?: number;
}): ScheduledInstalment[] {
	const period = FREQUENCY_MONTHS[params.frequency];
	const horizonEnd = addMonths(params.from, params.horizonMonths ?? 12);
	const limit = params.endDate && params.endDate < horizonEnd ? params.endDate : horizonEnd;
	const instalments: ScheduledInstalment[] = [];

	// Find the first monthly due date on or after `from`.
	let index = 0;
	while (addMonths(params.startDate, index) < params.from) index += 1;
	// Keep instalments aligned to the plan's period from the tenancy start.
	if (period > 1 && index % period !== 0) {
		// The months up to the next period boundary still need paying.
		const next = Math.ceil(index / period) * period;
		const dueDate = addMonths(params.startDate, index);
		const months = monthsBefore(params.startDate, index, next, params.endDate);
		if (dueDate < limit && months > 0) {
			instalments.push(instalment(dueDate, params.monthlyRent, months));
		}
		index = next;
	}

	for (; ; index += period) {
		const dueDate = addMonths(params.startDate, index);
		if (dueDate >= limit) break;
		const months = monthsBefore(params.startDate, index, index + period, params.endDate);
		if (months === 0) break;
		instalments.push(instalment(dueDate, params.monthlyRent, months));
	}
	return instalments;
}

function monthsBefore(
	startDate: Date,
	fromIndex: number,
	toIndex: number,
	endDate?: Date | null
): number {
	let months = 0;
	for (let i = fromIndex; i < toIndex; i += 1) {
		if (endDate && addMonths(startDate, i) >= endDate) break;
		months += 1;
	}
	return months;
}

function instalment(dueDate: Date, monthlyRent: number, months: number): ScheduledInstalment {
	const amount = monthlyRent * months;
	return { dueDate, amount, coversMonths: months, ...computeFee(amount) };
}

/** Stripe's standard payout lands this many working days after the charge. */
export const PAYOUT_DELAY_BUSINESS_DAYS = 2;

export function addBusinessDays(date: Date, days: number): Date {
	const result = new Date(date);
	let left = days;
	while (left > 0) {
		result.setUTCDate(result.getUTCDate() + 1);
		const weekday = result.getUTCDay();
		if (weekday !== 0 && weekday !== 6) left -= 1;
	}
	return result;
}

/**
 * Best estimate of the next payout: rent already paid lands two working days
 * after it was paid, and rent still to come lands two working days after it
 * is due. Returns null when nothing is on its way.
 */
export function estimateNextPayout(params: {
	paidAt: Date[];
	openDueDates: Date[];
	now: Date;
}): Date | null {
	const candidates = [
		...params.paidAt.map(date => addBusinessDays(date, PAYOUT_DELAY_BUSINESS_DAYS)),
		...params.openDueDates.map(date =>
			addBusinessDays(new Date(Math.max(date.getTime(), params.now.getTime())), PAYOUT_DELAY_BUSINESS_DAYS)
		)
	].filter(date => date.getTime() >= params.now.getTime());
	if (candidates.length === 0) return null;
	return new Date(Math.min(...candidates.map(date => date.getTime())));
}

/**
 * Where a brand-new schedule starts. A tenancy that began before Seek
 * tracked it is not back-filled: no due date in the past is created (it
 * would show as owed, then late, for rent paid outside Seek). The first
 * instalment is the next due date on or after today. A future start date is
 * used as is.
 */
export function firstTrackedDate(startDate: Date, now: Date): Date {
	const today = startOfUtcDay(now);
	return startDate.getTime() >= today.getTime() ? new Date(startDate) : today;
}

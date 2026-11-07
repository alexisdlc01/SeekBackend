import { BadRequestException } from "@nestjs/common";
import { allowedFrequencies, assertPlanAllowed } from "../payments/schedule";
import { PlanFrequency } from "../payments/payment.enums";
import { GuarantorCriterion } from "./enums/guarantor-criterion.enum";
import { Nation } from "./enums/nation.enum";

export interface Criteria {
	guarantor: GuarantorCriterion;
	referencesRequired: boolean;
	maxHousehold?: number;
}

export const DEFAULT_CRITERIA: Criteria = {
	guarantor: GuarantorCriterion.UK_OR_SERVICE,
	referencesRequired: false
};

/** Fills the blanks so a half-filled wizard step always stores a full object. */
export function normaliseCriteria(input: Partial<Criteria> | undefined | null): Criteria {
	return {
		guarantor: input?.guarantor ?? DEFAULT_CRITERIA.guarantor,
		referencesRequired: input?.referencesRequired ?? DEFAULT_CRITERIA.referencesRequired,
		...(input?.maxHousehold ? { maxHousehold: input.maxHousehold } : {})
	};
}

/**
 * The plans a listing offers. Every plan must be legal for the nation, so a
 * property in England can only ever offer MONTHLY (Renters' Rights Act).
 */
export function resolvePaymentPlans(
	nation: Nation | string | undefined,
	requested: PlanFrequency[] | undefined
): PlanFrequency[] {
	const plans = [...new Set(requested ?? [])];
	if (!plans.length) return [PlanFrequency.MONTHLY];
	for (const plan of plans) assertPlanAllowed(nation, plan);
	return plans;
}

/** Keeps the plans a landlord already chose that are still legal after a change of nation. */
export function plansAfterNationChange(
	nation: Nation | string | undefined,
	current: PlanFrequency[] | undefined
): PlanFrequency[] {
	const allowed = allowedFrequencies(nation);
	const kept = (current ?? []).filter(plan => allowed.includes(plan));
	return kept.length ? kept : [PlanFrequency.MONTHLY];
}

/** Viewing times must be in the future; stored sorted and without duplicates. */
export function normaliseViewingSlots(slots: string[], now: Date = new Date()): Date[] {
	const dates = slots.map(slot => new Date(slot));
	if (dates.some(date => Number.isNaN(date.getTime()) || date.getTime() <= now.getTime())) {
		throw new BadRequestException("Viewing times must be in the future.");
	}
	const unique = new Map(dates.map(date => [date.getTime(), date]));
	return [...unique.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** Product rule: a listing cannot go live with a move-in date before today (UTC day). */
export function assertAvailableFromNotPast(date: Date | string): void {
	const startOfToday = new Date().setUTCHours(0, 0, 0, 0);
	if (new Date(date).getTime() < startOfToday) {
		throw new BadRequestException("Available-from date is in the past. Pick today or a later date.");
	}
}

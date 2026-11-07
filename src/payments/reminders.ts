import { PaymentStatus } from "./payment.enums";
import { startOfUtcDay } from "./schedule";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a landlord wants Seek to nudge tenants about rent. */
export interface ReminderSchedule {
	/** Before the due date, using each tenant's own "remind me N days before". */
	beforeDue: boolean;
	/** On the day rent is due. */
	onDueDay: boolean;
	/** Once, three days after the due date, if it is still unpaid. */
	lateAfterThreeDays: boolean;
}

export const DEFAULT_REMINDER_SCHEDULE: ReminderSchedule = {
	beforeDue: true,
	onDueDay: true,
	lateAfterThreeDays: true
};

export const LATE_REMINDER_AFTER_DAYS = 3;
/** Old arrears are chased by hand; the automatic nudge stops after this. */
const LATE_REMINDER_WINDOW_DAYS = 14;

export type ReminderStage = "BEFORE" | "DUE_DAY" | "LATE";

export function normaliseReminderSchedule(value?: Partial<ReminderSchedule> | null): ReminderSchedule {
	return {
		beforeDue: value?.beforeDue ?? DEFAULT_REMINDER_SCHEDULE.beforeDue,
		onDueDay: value?.onDueDay ?? DEFAULT_REMINDER_SCHEDULE.onDueDay,
		lateAfterThreeDays: value?.lateAfterThreeDays ?? DEFAULT_REMINDER_SCHEDULE.lateAfterThreeDays
	};
}

/**
 * Which reminder, if any, a payment is due for today. Each stage is sent once
 * (the caller dedupes on payment + stage), so a missed sweep catches up.
 */
export function dueReminderStage(params: {
	status: PaymentStatus;
	dueDate: Date;
	today: Date;
	remindDaysBefore: number;
	schedule: ReminderSchedule;
}): ReminderStage | null {
	const daysUntil = Math.round(
		(startOfUtcDay(params.dueDate).getTime() - startOfUtcDay(params.today).getTime()) / DAY_MS
	);
	if (params.status === PaymentStatus.SCHEDULED) {
		if (daysUntil === 0) return params.schedule.onDueDay ? "DUE_DAY" : null;
		if (daysUntil > 0 && daysUntil <= params.remindDaysBefore) {
			return params.schedule.beforeDue ? "BEFORE" : null;
		}
		return null;
	}
	if (params.status === PaymentStatus.LATE) {
		const daysLate = -daysUntil;
		if (
			params.schedule.lateAfterThreeDays &&
			daysLate >= LATE_REMINDER_AFTER_DAYS &&
			daysLate <= LATE_REMINDER_WINDOW_DAYS
		) {
			return "LATE";
		}
	}
	return null;
}

import { PaymentStatus } from "./payment.enums";
import { DEFAULT_REMINDER_SCHEDULE, dueReminderStage, normaliseReminderSchedule } from "./reminders";

const today = new Date("2026-11-06T09:00:00Z");
const base = { today, remindDaysBefore: 3, schedule: DEFAULT_REMINDER_SCHEDULE };

describe("dueReminderStage", () => {
	it("reminds three days before, on the day and three days late", () => {
		expect(dueReminderStage({ ...base, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-09") })).toBe("BEFORE");
		expect(dueReminderStage({ ...base, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-10") })).toBeNull();
		expect(dueReminderStage({ ...base, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-06") })).toBe("DUE_DAY");
		expect(dueReminderStage({ ...base, status: PaymentStatus.LATE, dueDate: new Date("2026-11-03") })).toBe("LATE");
		expect(dueReminderStage({ ...base, status: PaymentStatus.LATE, dueDate: new Date("2026-11-05") })).toBeNull();
	});

	it("follows the tenant's own lead time for the early reminder", () => {
		expect(dueReminderStage({ ...base, remindDaysBefore: 7, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-12") })).toBe("BEFORE");
		expect(dueReminderStage({ ...base, remindDaysBefore: 0, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-07") })).toBeNull();
	});

	it("respects the landlord turning a stage off", () => {
		const schedule = normaliseReminderSchedule({ onDueDay: false, lateAfterThreeDays: false });
		expect(dueReminderStage({ ...base, schedule, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-11-06") })).toBeNull();
		expect(dueReminderStage({ ...base, schedule, status: PaymentStatus.LATE, dueDate: new Date("2026-11-01") })).toBeNull();
	});

	it("stops chasing arrears automatically after two weeks and ignores paid rent", () => {
		expect(dueReminderStage({ ...base, status: PaymentStatus.LATE, dueDate: new Date("2026-10-01") })).toBeNull();
		expect(dueReminderStage({ ...base, status: PaymentStatus.PAID, dueDate: new Date("2026-11-06") })).toBeNull();
	});
});

import { Types } from "mongoose";
import { PaymentsService } from "./payments.service";
import { PaymentStatus } from "./payment.enums";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

describe("PaymentsService reminders and receipts", () => {
	const now = new Date("2026-11-06T09:00:00Z");
	const tenant = new Types.ObjectId();
	const landlord = new Types.ObjectId();

	function setup(prefs: Record<string, unknown> | undefined, dueDate: Date) {
		const payment = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, status: PaymentStatus.SCHEDULED, dueDate };
		const paymentModel = {
			// Held payouts, then overdue, then reminder candidates.
			find: jest.fn().mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([payment])),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
			findOneAndUpdate: jest.fn()
		};
		const planModel = { find: jest.fn().mockReturnValue(lean([])), findOne: jest.fn().mockReturnValue(lean({ autopay: false })) };
		const userModel = {
			findById: jest.fn((id: Types.ObjectId, projection: Record<string, number>) =>
				lean(projection.notificationPrefs ? { notificationPrefs: prefs } : projection.rentReminderSchedule ? {} : { name: "Maya" })
			)
		};
		const listingModel = { find: jest.fn().mockReturnValue(lean([])) };
		const tenancyModel = { find: jest.fn().mockReturnValue({ populate: () => lean([]) }) };
		const notifications = { notify: jest.fn().mockResolvedValue(true) };
		const config = { get: (key: string) => (key === "STRIPE_SECRET_KEY" ? "set" : undefined) };
		const service = new PaymentsService(
			paymentModel as any,
			planModel as any,
			tenancyModel as any,
			listingModel as any,
			userModel as any,
			{} as any,
			{} as any,
			notifications as any,
			config as any,
			{} as any
		);
		return { service, notifications, paymentModel, planModel };
	}

	it("uses the tenant's rentReminderDaysBefore for the early reminder", async () => {
		const inFiveDays = new Date("2026-11-11T00:00:00Z");
		const five = setup({ rentReminderDaysBefore: 5 }, inFiveDays);
		await five.service.sweep(now);
		expect(five.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("is due on") }));

		const byDefault = setup(undefined, inFiveDays);
		await byDefault.service.sweep(now);
		expect(byDefault.notifications.notify).not.toHaveBeenCalled();
	});

	it("defaults to three days before", async () => {
		const { service, notifications } = setup({}, new Date("2026-11-09T00:00:00Z"));
		await service.sweep(now);
		expect(notifications.notify).toHaveBeenCalledTimes(1);
	});

	it("sends receipts under the every-payment preferences", async () => {
		const { service, notifications, paymentModel, planModel } = setup({}, now);
		const paid = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, payout: 69152, seekFee: 348, dueDate: now };
		paymentModel.findOneAndUpdate.mockReturnValue(lean(paid));
		planModel.findOne.mockReturnValue(lean({ notifyEveryPayment: false }));
		await (service as any).markPaid(paid, "SIMULATED", "sim_1");
		// The tenant turned receipts off on the plan; the landlord's goes through their pref.
		expect(notifications.notify).toHaveBeenCalledTimes(1);
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ user: landlord }), "landlordEveryPayment");

		notifications.notify.mockClear();
		planModel.findOne.mockReturnValue(lean({}));
		await (service as any).markPaid(paid, "SIMULATED", "sim_1");
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ user: tenant }), "receiptEveryPayment");
	});
});

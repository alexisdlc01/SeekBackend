import { Types } from "mongoose";
import { PaymentsService } from "./payments.service";
import { PaymentStatus } from "./payment.enums";
import { StripeClient } from "./stripe";

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

	it("marks a stale PENDING rent late, but not one attempted within the hour", async () => {
		const { service, paymentModel } = setup({}, now);
		const stale = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, status: PaymentStatus.PENDING, dueDate: new Date("2026-11-01") };
		paymentModel.find.mockReset().mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([stale])).mockReturnValue(lean([]));
		await service.sweep(now);
		const overdueQuery = paymentModel.find.mock.calls[1][0];
		expect(overdueQuery.$or).toContainEqual({ status: PaymentStatus.PENDING, updatedAt: { $lt: new Date(now.getTime() - 3600000) } });
		expect(paymentModel.updateOne).toHaveBeenCalledWith({ _id: stale._id, status: PaymentStatus.PENDING }, { $set: { status: PaymentStatus.LATE } });
	});

	describe("a stale PENDING rent with a Stripe intent", () => {
		afterEach(() => jest.restoreAllMocks());

		async function sweepWithIntent(status: string) {
			const { service, paymentModel } = setup({}, now);
			const stale = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, status: PaymentStatus.PENDING, providerRef: "pi_1", dueDate: new Date("2026-11-01") };
			paymentModel.find.mockReset().mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([stale])).mockReturnValue(lean([]));
			jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({ id: "pi_1", client_secret: null, status, amount: 69500 });
			const markPaid = jest.spyOn(service as any, "markPaid").mockResolvedValue(null);
			await service.sweep(now);
			const lateMarked = paymentModel.updateOne.mock.calls.some(([, update]) => update.$set?.status === PaymentStatus.LATE);
			return { lateMarked, markPaid, stale };
		}

		it("stays PENDING while the debit is processing", async () => {
			const { lateMarked, markPaid } = await sweepWithIntent("processing");
			expect(lateMarked).toBe(false);
			expect(markPaid).not.toHaveBeenCalled();
		});

		it("goes LATE once the attempt is dead", async () => {
			expect((await sweepWithIntent("requires_payment_method")).lateMarked).toBe(true);
			expect((await sweepWithIntent("canceled")).lateMarked).toBe(true);
		});

		it("is marked PAID when the intent already succeeded", async () => {
			const { lateMarked, markPaid, stale } = await sweepWithIntent("succeeded");
			expect(lateMarked).toBe(false);
			expect(markPaid).toHaveBeenCalledWith(stale, "stripe", "pi_1");
		});
	});

	it("defaults to three days before", async () => {
		const { service, notifications } = setup({}, new Date("2026-11-09T00:00:00Z"));
		await service.sweep(now);
		expect(notifications.notify).toHaveBeenCalledTimes(1);
	});

	it("sends receipts under the every-payment preferences", async () => {
		const { service, notifications, paymentModel, planModel } = setup({}, now);
		const paid = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, payout: 68805, seekFee: 695, dueDate: now };
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

describe("PaymentsService.remindOne channels", () => {
	let nodeEnv: string | undefined = "production";

	it("emails the tenant and posts in the household thread, and survives a failing channel", async () => {
		const landlord = new Types.ObjectId();
		const tenant = new Types.ObjectId();
		const conversation = new Types.ObjectId();
		const payment = { _id: new Types.ObjectId(), tenancy: new Types.ObjectId(), tenant, landlord, amount: 69500, status: PaymentStatus.LATE, dueDate: new Date("2026-11-01"), kind: "RENT" };
		const paymentModel = { findById: jest.fn().mockReturnValue(lean(payment)), updateOne: jest.fn() };
		const userModel = { findById: jest.fn().mockReturnValue(lean({ email: "maya@seek.local", name: "Maya" })) };
		const tenancyModel = { findById: jest.fn().mockReturnValue(lean({ application: new Types.ObjectId() })) };
		const applicationModel = { findById: jest.fn().mockReturnValue(lean({ conversation })) };
		const mail = { sendRentReminderEmail: jest.fn().mockRejectedValue(new Error("mailgun down")) };
		const conversations = { sendMessage: jest.fn().mockResolvedValue(undefined) };
		const service = new PaymentsService(
			paymentModel as any, {} as any, tenancyModel as any, {} as any, userModel as any, {} as any, {} as any,
			{ notify: jest.fn().mockResolvedValue(true) } as any, { get: (key: string) => (key === "NODE_ENV" ? nodeEnv : undefined) } as any, applicationModel as any,
			mail as any, conversations as any
		);

		await expect(service.remindOne(landlord.toString(), payment._id.toString())).resolves.toEqual({ reminded: 1, skipped: 0 });
		expect(mail.sendRentReminderEmail).toHaveBeenCalledWith("maya@seek.local", "Maya", expect.stringContaining("overdue"), expect.any(String), "/student/home/rent");
		expect(conversations.sendMessage).toHaveBeenCalledWith(
			{ message: expect.stringContaining("Seek reminder for Maya") },
			conversation.toString(),
			landlord.toString()
		);
		expect(paymentModel.updateOne).toHaveBeenCalled();

		// A hand-made tenancy has no thread: email only.
		conversations.sendMessage.mockClear();
		tenancyModel.findById.mockReturnValue(lean({ application: null }));
		await service.remindOne(landlord.toString(), payment._id.toString(), new Date(Date.now() + 2 * 86400000));
		expect(conversations.sendMessage).not.toHaveBeenCalled();
	});
});

describe("PaymentsService.destinationFor", () => {
	afterEach(() => jest.restoreAllMocks());

	async function destination(landlord: Record<string, unknown>) {
		const userModel = { findById: jest.fn().mockReturnValue(lean(landlord)) };
		const service = new PaymentsService({} as any, {} as any, {} as any, {} as any, userModel as any, {} as any, {} as any, {} as any, {} as any, {} as any);
		const retrieve = jest.spyOn(StripeClient.prototype, "retrieveAccount").mockResolvedValue({ id: "acct_1", capabilities: { transfers: "active" } } as any);
		const result = await (service as any).destinationFor(new StripeClient("sk_test"), new Types.ObjectId());
		return { result, retrieve };
	}

	it("pays a ready landlord", async () => {
		expect((await destination({ stripeAccountId: "acct_1" })).result).toBe("acct_1");
	});

	it("holds the money of a suspended or deleted landlord", async () => {
		expect((await destination({ stripeAccountId: "acct_1", suspendedAt: new Date() })).result).toBeNull();
		expect((await destination({ stripeAccountId: "acct_1", deletedAt: new Date() })).result).toBeNull();
	});
});

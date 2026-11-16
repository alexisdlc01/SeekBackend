import { WeeklySummarySweeper } from "./weekly-summary.sweeper";

const chain = (value: unknown) => ({ lean: () => ({ exec: async () => value }), populate: () => chain(value) });

function build(opts: { applications?: number; paid?: { payout: number; payoutStatus?: string | null }[]; listings?: unknown[]; claim?: unknown; sentAt?: Date }) {
	const landlord = { _id: "l1", email: "l@example.com", name: "Lee <b>", weeklySummarySentAt: opts.sentAt };
	const userModel = {
		find: jest.fn((..._args: unknown[]) => chain([landlord])),
		findOneAndUpdate: jest.fn((..._args: unknown[]) => chain(opts.claim === undefined ? { _id: "l1" } : opts.claim)),
		updateOne: jest.fn((..._args: unknown[]) => ({ exec: async () => ({}) }))
	};
	const applicationModel = { countDocuments: jest.fn(async (..._args: unknown[]) => opts.applications ?? 0) };
	const paymentModel = { find: jest.fn((..._args: unknown[]) => chain(opts.paid ?? [])) };
	const listingModel = { find: jest.fn((..._args: unknown[]) => chain(opts.listings ?? [])) };
	const tenancyModel = { find: jest.fn((..._args: unknown[]) => chain([])) };
	const mail = { sendWeeklySummaryEmail: jest.fn().mockResolvedValue(undefined) };
	const sweeper = new WeeklySummarySweeper(paymentModel as never, applicationModel as never, listingModel as never, tenancyModel as never, userModel as never, mail as never, {} as never);
	return { sweeper, mail, userModel, applicationModel, paymentModel, listingModel, tenancyModel };
}

describe("WeeklySummarySweeper", () => {
	it("emails an opted-in landlord with activity, scoped to that landlord", async () => {
		const { sweeper, mail, userModel, applicationModel, paymentModel, listingModel, tenancyModel } = build({
			applications: 2,
			paid: [{ payout: 49500 }, { payout: 24800, payoutStatus: "TRANSFERRED" }, { payout: 10000, payoutStatus: "HELD" }]
		});
		await sweeper.sendAll(new Date("2026-11-16T10:00:00Z"));
		expect(userModel.find.mock.calls[0][0]).toMatchObject({ "notificationPrefs.weeklySummary": true });
		expect(applicationModel.countDocuments.mock.calls[0][0]).toMatchObject({ landlord: "l1" });
		expect(paymentModel.find.mock.calls[0][0]).toMatchObject({ landlord: "l1" });
		expect(listingModel.find.mock.calls[0][0]).toMatchObject({ landlord: "l1" });
		expect(tenancyModel.find.mock.calls[0][0]).toMatchObject({ landlord: "l1" });
		expect(userModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: "l1" });
		expect((userModel.findOneAndUpdate.mock.calls[0][0] as { $or: { weeklySummarySentAt: { $lt: Date } }[] }).$or[2].weeklySummarySentAt.$lt).toEqual(new Date("2026-11-16T00:00:00Z"));
		expect(mail.sendWeeklySummaryEmail).toHaveBeenCalledWith("l@example.com", "Lee <b>", [
			"2 new applications",
			"2 payments received, £743.00 in total",
			"£100.00 held by Seek until you set up payouts"
		]);
	});

	it("starts the window at the last send when that is less than 7 days ago", async () => {
		const sentAt = new Date("2026-11-11T10:00:00Z"); // Wednesday
		const { sweeper, applicationModel, paymentModel } = build({ applications: 1, sentAt });
		await sweeper.sendAll(new Date("2026-11-16T10:00:00Z")); // Monday
		expect(applicationModel.countDocuments.mock.calls[0][0]).toMatchObject({ sentAt: { $gte: sentAt } });
		expect(paymentModel.find.mock.calls[0][0]).toMatchObject({ paidAt: { $gte: sentAt } });
	});

	it("keeps the last send as the start when a failed send made the gap 8 days", async () => {
		const sentAt = new Date("2026-11-09T10:00:00Z");
		const { sweeper, applicationModel, paymentModel } = build({ applications: 1, sentAt });
		await sweeper.sendAll(new Date("2026-11-17T10:00:00Z"));
		expect(applicationModel.countDocuments.mock.calls[0][0]).toMatchObject({ sentAt: { $gte: sentAt } });
		expect(paymentModel.find.mock.calls[0][0]).toMatchObject({ paidAt: { $gte: sentAt } });
	});

	it("caps the window at 14 days when the last send is older", async () => {
		const { sweeper, paymentModel } = build({ applications: 1, sentAt: new Date("2026-10-01T10:00:00Z") });
		await sweeper.sendAll(new Date("2026-11-16T10:00:00Z"));
		expect(paymentModel.find.mock.calls[0][0]).toMatchObject({ paidAt: { $gte: new Date("2026-11-02T10:00:00Z") } });
	});

	it("claims against the start of the London week on a Wednesday, DST-correct", async () => {
		const run = async (now: string) => {
			const { sweeper, userModel } = build({ applications: 1 });
			await sweeper.sendAll(new Date(now));
			return (userModel.findOneAndUpdate.mock.calls[0][0] as { $or: { weeklySummarySentAt: { $lt: Date } }[] }).$or[2].weeklySummarySentAt.$lt;
		};
		expect(await run("2026-11-18T10:00:00Z")).toEqual(new Date("2026-11-16T00:00:00Z")); // GMT
		expect(await run("2026-04-01T10:00:00Z")).toEqual(new Date("2026-03-29T23:00:00Z")); // BST: Mon 30 Mar 00:00
		expect(await run("2026-03-29T02:00:00Z")).toEqual(new Date("2026-03-23T00:00:00Z")); // Sunday of the spring change
		expect(await run("2026-10-25T12:00:00Z")).toEqual(new Date("2026-10-18T23:00:00Z")); // Sunday of the autumn change: Mon 19 Oct 00:00 BST
	});

	it("includes a compliance line for a certificate due soon", async () => {
		const now = new Date("2026-11-16T10:00:00Z");
		const listing = { _id: "p1", propertyTitle: "Flat 2", gasSafetyExpiry: new Date(now.getTime() + 5 * 86400000) };
		const { sweeper, mail } = build({ listings: [listing] });
		await sweeper.sendAll(now);
		const lines = mail.sendWeeklySummaryEmail.mock.calls[0][2] as string[];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("expires soon");
	});

	it("sends nothing when another run already claimed this week", async () => {
		const { sweeper, mail } = build({ applications: 1, claim: null });
		await sweeper.sendAll();
		expect(mail.sendWeeklySummaryEmail).not.toHaveBeenCalled();
	});

	it("restores the previous claim value when sending fails", async () => {
		const previous = new Date("2026-11-09T10:00:00Z");
		const now = new Date("2026-11-16T10:00:00Z");
		const { sweeper, mail, userModel } = build({ applications: 1, claim: { _id: "l1", weeklySummarySentAt: previous } });
		mail.sendWeeklySummaryEmail.mockRejectedValue(new Error("mailgun 503"));
		await expect(sweeper.sendAll(now)).resolves.not.toThrow();
		expect(userModel.updateOne).toHaveBeenCalledWith({ _id: "l1", weeklySummarySentAt: now }, { $set: { weeklySummarySentAt: previous } });
	});

	it("skips when there is nothing to report", async () => {
		const { sweeper, mail, userModel } = build({});
		await sweeper.sendAll();
		expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
		expect(mail.sendWeeklySummaryEmail).not.toHaveBeenCalled();
	});
});

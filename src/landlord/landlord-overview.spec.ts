import { Types } from "mongoose";
import { LandlordOverviewService } from "./landlord-overview.service";

// Any query chain (populate/select/sort/limit/lean) that resolves to `value`.
const query = (value: unknown): unknown => new Proxy({}, {
	get: (_target, key) => (key === "exec" ? async () => value : key === "then" ? undefined : () => query(value))
});
const model = (find: unknown[] = [], letListings: unknown[] = []) => ({ find: () => query(find), countDocuments: async () => 0, distinct: () => query(letListings) });

describe("LandlordOverviewService todo", () => {
	const now = new Date("2026-11-07T12:00:00Z");
	const verified = ["PASSPORT", "RIGHT_TO_RENT", "STUDENT_STATUS", "PROOF_OF_FUNDS"].map(type => ({
		type, status: "VERIFIED", uploadedAt: now, expiresAt: new Date("2030-01-01")
	}));
	const listing = { _id: new Types.ObjectId(), numOfPeople: 2, criteria: { guarantor: "NONE" }, propertyTitle: "22 Kingsdown Parade" };
	const application = (stage: string, documents: unknown[], sentAt: string) => ({
		_id: new Types.ObjectId(), listing, stage, sentAt: new Date(sentAt), viewingAt: new Date("2026-11-01T17:00:00Z"),
		applicants: [{ documents }, { documents }]
	});

	it("points at the first qualified household per listing, skipping unqualified earlier ones", async () => {
		const unqualified = application("SENT", [], "2026-11-01");
		const first = application("SENT", verified, "2026-11-02");
		const second = application("SENT", verified, "2026-11-03");
		const service = new LandlordOverviewService(
			model() as never, model() as never, model() as never, model() as never,
			model([unqualified, first, second]) as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), now);
		const offers = overview.todo.filter(item => item.kind === "MAKE_OFFER");
		expect(offers).toEqual([expect.objectContaining({
			applicationId: first._id.toString(), listingTitle: "22 Kingsdown Parade", members: 2, allVerified: true
		})]);
		expect(overview.holdingDepositsCollectedThisMonth).toBe(0);
	});

	it("leaves a let property out of the offers to make and the qualified count", async () => {
		const waiting = application("SENT", verified, "2026-11-02");
		const service = new LandlordOverviewService(
			model() as never, model() as never, model() as never, model() as never,
			model([waiting], [listing._id]) as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), now);
		expect(overview.todo.filter(item => item.kind === "MAKE_OFFER")).toEqual([]);
		expect(overview.applicants.qualified).toBe(0);
	});

	it("leaves rent cancelled by an early tenancy end out of rent expected", async () => {
		const payments = [{ amount: 62000, seekFee: 620, status: "PAID", kind: "RENT" }, { amount: 62000, seekFee: 620, status: "CANCELLED", kind: "RENT" }];
		const paymentModel = { find: jest.fn().mockReturnValueOnce(query(payments)).mockReturnValue(query([])), countDocuments: async () => 0, distinct: () => query([]) };
		const service = new LandlordOverviewService(
			model() as never, model() as never, paymentModel as never, model() as never,
			model() as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), now);
		expect(overview.rentExpectedThisMonth).toBe(62000);
		expect(overview.rentCollectedThisMonth).toBe(62000);
	});

	it("shows rent due later this month as not due yet (the month query selects dueDate)", async () => {
		// Like Mongo, .select() keeps only the listed fields.
		const projected = (rows: Record<string, unknown>[]) => ({
			select: (fields: string) => query(rows.map(row => Object.fromEntries(fields.split(" ").filter(f => f in row).map(f => [f, row[f]]))))
		});
		const tenancy = { _id: new Types.ObjectId(), listing, tenants: [{}, {}] };
		const later = { amount: 62000, seekFee: 620, status: "SCHEDULED", kind: "RENT", tenancy: tenancy._id, dueDate: new Date("2026-11-28T00:00:00Z") };
		const paymentModel = { find: jest.fn().mockReturnValueOnce(projected([later])).mockReturnValue(query([])), countDocuments: async () => 0, distinct: () => query([]) };
		const service = new LandlordOverviewService(
			model([tenancy]) as never, model([listing]) as never, paymentModel as never, model() as never,
			model() as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), now);
		expect(overview.properties[0].rentStatus).toBe("NOT_DUE");
	});

	it("counts only the Seek fee kept on a refunded rent", async () => {
		const payments = [{ amount: 62000, seekFee: 620, status: "PAID", kind: "RENT", refundedAt: now, refundedAmount: 31000 }];
		const paymentModel = { find: jest.fn().mockReturnValueOnce(query(payments)).mockReturnValue(query([])), countDocuments: async () => 0, distinct: () => query([]) };
		const service = new LandlordOverviewService(
			model() as never, model() as never, paymentModel as never, model() as never,
			model() as never, model() as never, model() as never
		);
		expect((await service.overview(new Types.ObjectId().toString(), now)).seekFeeThisMonth).toBe(310);
	});

	it("picks the month on the London clock: 00:30 BST on 1 April is April", async () => {
		const paymentModel = { find: jest.fn(() => query([])), countDocuments: async () => 0, distinct: () => query([]) };
		const service = new LandlordOverviewService(
			model() as never, model() as never, paymentModel as never, model() as never,
			model() as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), new Date("2026-03-31T23:30:00Z"));
		expect(paymentModel.find.mock.calls[0]).toEqual([expect.objectContaining({ dueDate: { $gte: new Date("2026-04-01T00:00:00Z"), $lt: new Date("2026-05-01T00:00:00Z") } })]);
		expect(overview.month).toBe("2026-04");
	});

	it("shows a late payment of an ended tenancy on its listing's row", async () => {
		const ended = { _id: new Types.ObjectId(), listing: listing._id };
		const late = { amount: 62000, seekFee: 620, status: "LATE", kind: "RENT", tenancy: ended._id, dueDate: new Date("2026-11-01T00:00:00Z") };
		const paymentModel = { find: jest.fn().mockReturnValueOnce(query([late])).mockReturnValue(query([])), countDocuments: async () => 0, distinct: () => query([]) };
		const tenancyModel = { find: jest.fn().mockReturnValueOnce(query([])).mockReturnValue(query([ended])), distinct: () => query([]) };
		const service = new LandlordOverviewService(
			tenancyModel as never, model([listing]) as never, paymentModel as never, model() as never,
			model() as never, model() as never, model() as never
		);
		const overview = await service.overview(new Types.ObjectId().toString(), now);
		expect(overview.properties[0].arrears).toBe(62000);
	});
});

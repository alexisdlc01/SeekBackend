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
});

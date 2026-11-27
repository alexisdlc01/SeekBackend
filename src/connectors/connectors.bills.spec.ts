import { Types } from "mongoose";
import { ConnectorsService } from "./connectors.service";

describe("fileBill", () => {
	const tenancy = { _id: new Types.ObjectId(), tenants: [] };
	const owner = new Types.ObjectId();
	const classification = { counterpartName: "Hyperoptic" } as any;
	const email = (id: string, receivedAt: string, internetMessageId: string | null = null) =>
		({ providerMessageId: id, internetMessageId, from: "bills@hyperoptic.test", fromName: "Hyperoptic", subject: "Your broadband invoice", body: "Total: £30.00", receivedAt: new Date(receivedAt) }) as any;

	const matches = (r: any, q: any): boolean =>
		Object.entries(q).every(([k, v]: [string, any]) =>
			k === "$or" ? v.some((sub: any) => matches(r, sub)) : v?.$gte ? r[k] >= v.$gte : v === null ? r[k] == null : String(r[k]) === String(v)
		);

	function setup() {
		const rows: any[] = [];
		const service = Object.create(ConnectorsService.prototype) as any;
		service.billModel = {
			exists: jest.fn(async (q: any) => rows.find(r => matches(r, q)) ?? null),
			create: jest.fn(async (doc: any) => rows.push({ ...doc, createdAt: new Date() }))
		};
		return { rows, file: (mail: any) => service.fileBill({ tenancy, listing: null }, classification, mail, owner) };
	}

	it("files a fixed monthly bill whose subject has no month, every month", async () => {
		const { rows, file } = setup();
		await file(email("m1", "2026-09-01T09:00:00Z"));
		await file(email("m2", "2026-10-01T09:00:00Z"));
		expect(rows).toHaveLength(2);
	});

	it("records the mailbox owner as addedBy", async () => {
		const { rows, file } = setup();
		await file(email("m1", "2026-09-01T09:00:00Z"));
		expect(rows[0]).toMatchObject({ source: "EMAIL", addedBy: owner });
	});

	it("does not file the same email twice (two attachments)", async () => {
		const { rows, file } = setup();
		await file(email("m1", "2026-09-01T09:00:00Z"));
		await expect(file(email("m1", "2026-09-01T09:00:00Z"))).resolves.toBe(true);
		expect(rows).toHaveLength(1);
	});

	it("files one bill when two flatmates receive the same email", async () => {
		const { rows, file } = setup();
		await file(email("alice-gmail-1", "2026-09-01T09:00:00Z", "<inv-42@hyperoptic.test>"));
		await file(email("bob-outlook-9", "2026-09-01T09:00:00Z", "<inv-42@hyperoptic.test>"));
		expect(rows).toHaveLength(1);
	});

	it("reads the verb 'may' as no month, never as May", async () => {
		const { rows, file } = setup();
		await file({ ...email("m1", "2026-11-03T09:00:00Z"), subject: "Your October energy bill - you may pay by direct debit" });
		await file({ ...email("m2", "2026-11-03T09:00:00Z"), subject: "Your bill: payment may take 3 days" });
		await file({ ...email("m3", "2026-12-03T09:00:00Z"), subject: "Your bill: payment may take 3 days" });
		expect(rows.map(r => r.periodStart?.toISOString() ?? null)).toEqual(["2026-10-01T00:00:00.000Z", null, null]);
		await file({ ...email("m4", "2026-06-03T09:00:00Z"), subject: "Your May statement" });
		expect(rows[3].periodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
	});

	it("does not refile a recent bill saved before emails were keyed (reconnect)", async () => {
		const { rows, file } = setup();
		rows.push({ tenancy: tenancy._id, provider: "Hyperoptic", amount: 3000, periodStart: null, sourceMessageId: null, createdAt: new Date() });
		await file(email("m1", "2026-09-01T09:00:00Z", "<inv-42@hyperoptic.test>"));
		expect(rows).toHaveLength(1);
	});
});

describe("tenancyFor (student, unknown sender)", () => {
	it("files on the home running now, not next year's tenancy", async () => {
		const day = 86_400_000;
		const current = { _id: new Types.ObjectId(), startDate: new Date(Date.now() - 30 * day), endDate: new Date(Date.now() + 200 * day), listing: new Types.ObjectId() };
		const nextYear = { _id: new Types.ObjectId(), startDate: new Date(Date.now() + 300 * day), endDate: null, listing: new Types.ObjectId() };
		const ended = { _id: new Types.ObjectId(), startDate: new Date(Date.now() - 400 * day), endDate: new Date(Date.now() - 40 * day), listing: new Types.ObjectId() };
		const chain = (value: any) => {
			const c: any = { sort: () => c, select: () => c, lean: () => c, exec: async () => value };
			return c;
		};
		const service = Object.create(ConnectorsService.prototype) as any;
		// Returned in startDate order, as the sorted query would.
		service.tenancyModel = { find: jest.fn(() => chain([ended, current, nextYear])), findOne: jest.fn(() => chain(nextYear)) };
		service.listingModel = { findById: jest.fn(() => chain(null)) };
		const user = { _id: new Types.ObjectId(), role: "STUDENT" };
		const target = await service.tenancyFor(user, {} as any, { subject: "Bill", body: "" } as any);
		expect(target.tenancy._id).toBe(current._id);
	});
});

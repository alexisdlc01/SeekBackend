import { AiService, listingChecks, quickReplies } from "./ai.service";

describe("AiService searchChat with a model answer", () => {
	function setup(text: string) {
		const llm = { isConfigured: () => true, complete: jest.fn().mockResolvedValue({ text, provider: "gemini" }) };
		const none = {} as any;
		const service = new AiService(llm as any, none, none, none, none, none, none, none, none, none, { get: () => undefined } as any);
		const findListings = jest.spyOn(service as any, "findListings").mockResolvedValue({ listings: [{ _id: "l1" }], relaxed: [] });
		return { service, findListings };
	}
	const messages = [{ role: "user" as const, content: "2-bed in Cotham under £700 bills included" }];

	it("ignores debris fields and fills filters the model dropped from what the student wrote", async () => {
		const { service, findListings } = setup(
			'{"reply":"2-bed homes in Bristol under £700.","filters":{"city":"Bristol","maxRent":700,"minBedrooms":2,"moveIn":"","nearUniversity":": null"}}'
		);
		const result = await service.searchChat(messages, new Date("2026-11-07T12:00:00Z"));
		expect(result.provider).toBe("gemini");
		expect(result.filters).toEqual({ city: "Bristol", area: "Cotham", maxRent: 700, minBedrooms: 2, billsIncluded: true });
		expect(findListings).toHaveBeenCalledWith(result.filters, undefined);
		expect(result.suggestions).toEqual(["Quiet streets", "Nightlife", "Either"]);
	});

	it("keeps the Scottish town when the model files St Andrews under Bristol", async () => {
		const { service } = setup(
			'{"reply":"2-bed homes in St Andrews, Bristol.","filters":{"city":"Bristol","area":"St Andrews","maxRent":800,"minBedrooms":2,"billsIncluded":true}}'
		);
		const result = await service.searchChat(
			[{ role: "user", content: "2 bed in St Andrews under £800 each, bills included" }],
			new Date("2026-11-07T12:00:00Z")
		);
		expect(result.provider).toBe("rules");
		expect(result.filters).toEqual({ city: "St Andrews", maxRent: 800, minBedrooms: 2, billsIncluded: true });
	});

	it("falls back to the rules parser when the answer is not JSON", async () => {
		const { service } = setup("{not json");
		const result = await service.searchChat(messages, new Date("2026-11-07T12:00:00Z"));
		expect(result.provider).toBe("rules");
		expect(result.filters.area).toBe("Cotham");
	});
});

describe("search result checks and quick replies", () => {
	it("asks for what the search still lacks", () => {
		expect(quickReplies({})).toEqual(["Bristol", "Manchester", "Leeds"]);
		expect(quickReplies({ city: "Bristol" })).toEqual(["Under £600", "Under £750", "Under £900"]);
	});

	it("flags budget, EPC and the landlord's criteria", () => {
		const listing = { rentPerPerson: 720, epcRating: "D", criteria: { guarantor: "NONE" as any, referencesRequired: true } };
		const checks = listingChecks(listing, { maxRent: 700 }, { documents: [] });
		expect(checks).toEqual([
			{ kind: "warn", text: "To pass the landlord's checks, finish your Seek Passport and add a verified reference" },
			{ kind: "warn", text: "£20 over your £700 budget" },
			{ kind: "warn", text: "EPC D: heating may cost more in winter" }
		]);
		expect(listingChecks({ rentPerPerson: 650, epcRating: "B" }, { maxRent: 700 })).toEqual([
			{ kind: "pass", text: "Within your £700 budget" },
			{ kind: "pass", text: "EPC B: efficient to heat" }
		]);
	});
});

describe("AiService household advice (topic application + applicationId)", () => {
	const landlordId = "64b000000000000000000001";
	const lean = (value: unknown) => ({ populate() { return this; }, select() { return this; }, lean() { return this; }, exec: async () => value });
	function setup() {
		const application = {
			_id: "64b0000000000000000000a1",
			landlord: landlordId,
			listing: "64b0000000000000000000b1",
			applicants: [{ _id: "64b0000000000000000000c1", name: "Maya", documents: [] }]
		};
		const applicationModel = { findById: () => lean(application) };
		const listingModel = { findById: () => lean({ propertyTitle: "14 Cotham Grove", numOfPeople: 2, criteria: { guarantor: "NONE" } }) };
		const none = {} as any;
		const llm = { isConfigured: () => false };
		return new AiService(llm as any, none, none, none, listingModel as any, none, none, applicationModel as any, none, none, { get: () => undefined } as any);
	}

	it("lists the criteria the household misses and what each member still needs", async () => {
		const result = await setup().advice({ _id: landlordId, role: "LANDLORD_AGENCY" } as any, { topic: "application", applicationId: "64b0000000000000000000a1" });
		expect(result.title).toBe("Not qualified yet");
		expect(result.advice).toContain("This household doesn't qualify for 14 Cotham Grove yet");
		expect(result.advice).toContain("Household fills the property (1 of 2 people)");
		expect(result.advice).toMatch(/Maya: still needs /);
		expect(result.provider).toBe("rules");
	});

	it("refuses anyone outside the household and the listing's landlord", async () => {
		await expect(setup().advice({ _id: "64b0000000000000000000ff", role: "STUDENT" } as any, { topic: "application", applicationId: "64b0000000000000000000a1" }))
			.rejects.toThrow("not part of this application");
	});
});

describe("AiService bills advice", () => {
	it("ignores bills where the student's own share is already paid", async () => {
		const maya = "64b000000000000000000011";
		const tom = "64b000000000000000000012";
		const bills = [
			{ amount: 4000, status: "DUE", includedInRent: false, splitBetween: [maya, tom], paidShares: [maya] },
			{ amount: 6000, status: "DUE", includedInRent: false, splitBetween: [maya, tom], paidShares: [] }
		];
		const billModel = { find: () => ({ sort() { return this; }, lean() { return this; }, exec: async () => bills }) };
		const none = {} as any;
		const service = new AiService({ isConfigured: () => false } as any, none, none, none, none, billModel as any, none, none, none, none, { get: () => undefined } as any);
		const draft = await (service as any).billsAdvice({ _id: maya, role: "STUDENT" }, { _id: "t1", tenants: [maya, tom], documents: [] }, { propertyTitle: "14 Cotham Grove" });
		expect(draft.advice).toContain("1 bill is unpaid; your share is £30.");
	});
});

describe("AiService advice for a home in Scotland", () => {
	const none = {} as any;
	const billModel = { find: () => ({ sort() { return this; }, lean() { return this; }, exec: async () => [] }) };
	const service = new AiService({ isConfigured: () => false } as any, none, none, none, none, billModel as any, none, none, none, none, { get: () => undefined } as any);
	const student = { _id: "64b000000000000000000011", role: "STUDENT" };
	const listing = { propertyTitle: "3 North Street", nation: "SCOTLAND" };

	it("uses the Scottish schemes, the two-month cap and 30 working days from the start", () => {
		// £650 a month, £1,300 deposit: exactly two months, so within the Scottish cap (five weeks would be £750).
		const tenancy = { _id: "t1", tenants: [student._id], documents: [], monthlyRent: 65000, depositAmount: 130000, startDate: new Date("2026-09-01T00:00:00Z") };
		const draft = (service as any).depositAdvice(student, tenancy, listing, new Date("2026-09-02T00:00:00Z"));
		expect(draft.advice).toContain("SafeDeposits Scotland, Letting Protection Service Scotland or mydeposits Scotland by 13 October 2026");
		expect(draft.advice).toContain("within the legal cap of two months' rent (£1300).");
		expect(draft.advice).not.toMatch(/DPS|TDS|five weeks/);
	});

	it("links council tax to mygov.scot, not GOV.UK", async () => {
		const draft = await (service as any).billsAdvice(student, { _id: "t1", tenants: [student._id], documents: [] }, listing);
		expect(draft.actions.map((action: { link: string }) => action.link).join(" ")).toContain("mygov.scot/council-tax");
		expect(JSON.stringify(draft)).not.toContain("gov.uk");
	});
});

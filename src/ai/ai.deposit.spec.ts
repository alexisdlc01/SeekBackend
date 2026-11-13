import { ThrottlerStorageService } from "@nestjs/throttler";
import { AiService, STUDENT_PROTECTS_DEPOSIT, addsUnsafeDetails } from "./ai.service";
import { AiController } from "./ai.controller";
import { Role } from "../auth/role.enum";

describe("deposit advice wording", () => {
	const now = new Date("2026-09-20T12:00:00Z");
	const tenancy = { monthlyRent: 80000, depositAmount: 80000, depositScheme: undefined, documents: [], tenants: [], depositReceivedAt: new Date("2026-09-13T00:00:00Z") } as any;
	const none = {} as any;
	const make = (llm: any) => new AiService(llm, none, none, none, none, none, none, none, none, none, { get: () => undefined } as any);
	const draftFor = (role: Role) => (make({ isConfigured: () => false }) as any).depositAdvice({ role, _id: "u1" }, tenancy, null, now);

	it("tells the student the landlord must protect it, and what to ask for", () => {
		const draft = draftFor(Role.STUDENT);
		expect(draft.title).toMatch(/^Your landlord must protect your deposit/);
		expect(draft.advice).toMatch(/landlord's legal duty/);
		expect(draft.advice).toMatch(/certificate and the prescribed information/);
	});

	it("keeps telling the landlord to protect it", () => {
		expect(draftFor(Role.LANDLORD_AGENCY).title).toMatch(/^Protect the deposit/);
	});

	it("falls back to the rules text when the model tells the student to protect it", async () => {
		const bad = "Protect your deposit by 13 October 2027 in an approved scheme.";
		const llm = { isConfigured: () => true, complete: jest.fn().mockResolvedValue({ text: JSON.stringify({ advice: bad }), provider: "gemini" }) };
		const service = make(llm);
		jest.spyOn(service as any, "draftAdvice").mockResolvedValue(draftFor(Role.STUDENT));
		const result = await service.advice({ role: Role.STUDENT, _id: "u1" } as any, { topic: "deposit" } as any, now);
		expect(result.source).toBe("rules");
		expect(result.advice).not.toMatch(STUDENT_PROTECTS_DEPOSIT);
		expect(llm.complete.mock.calls[0][0].system).toMatch(/LANDLORD/);
	});
});

describe("bills advice and the energy fair-use allowance", () => {
	const maya = "a".repeat(24);
	const tom = "b".repeat(24);
	const energyBill = (amount: number) => ({
		category: "ENERGY",
		provider: "Octopus",
		amount,
		status: "PAID",
		periodStart: new Date("2026-10-01T00:00:00Z"),
		periodEnd: new Date("2026-10-31T00:00:00Z")
	});
	const advise = (amount: number, role = Role.STUDENT, energyAllowance = 10000) => {
		const billModel = { find: () => ({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve([energyBill(amount)]) }) }) }) };
		const none = {} as any;
		const service = new AiService(none, none, none, none, none, billModel as any, none, none, none, none, { get: () => undefined } as any);
		const tenancy = { _id: "t1", tenants: [maya, tom], energyAllowance, documents: [] };
		return (service as any).billsAdvice({ role, _id: maya }, tenancy, null);
	};

	it("warns when usage is over the allowance, with the student's own share", async () => {
		const { advice } = await advise(13000);
		expect(advice).toMatch(/130% of the fair-use allowance/);
		expect(advice).toMatch(/£30 over the allowance/);
		expect(advice).toMatch(/£15 for you/);
	});

	it("warns when usage is close to the allowance", async () => {
		expect((await advise(9000)).advice).toMatch(/90% .*close to the limit/);
	});

	it("just reports usage well inside the allowance", async () => {
		const { advice } = await advise(5000);
		expect(advice).toMatch(/50% of the fair-use allowance/);
		expect(advice).not.toMatch(/close to the limit|over the allowance/);
	});

	it("says there is no allowance (no 0%) when the allowance is 0", async () => {
		const { advice } = await advise(12000, Role.STUDENT, 0);
		expect(advice).toMatch(/no energy allowance/);
		expect(advice).not.toMatch(/0% of the fair-use/);
	});
});

describe("AI advice privacy and abuse limits", () => {
	it("flags sort codes, account numbers, IBANs, unknown links and emails, not Seek's own links", () => {
		expect(addsUnsafeDetails("Transfer it to sort code 12-34-56 today.")).toBe(true);
		expect(addsUnsafeDetails("Transfer it to 12.34.56 today.")).toBe(true);
		expect(addsUnsafeDetails("Transfer it to 12/34/56 today.")).toBe(true);
		expect(addsUnsafeDetails("Pay account 12345678 now.")).toBe(true);
		expect(addsUnsafeDetails("Call 07123 456 789.")).toBe(true);
		expect(addsUnsafeDetails("Use GB29NWBK60161331926819.")).toBe(true);
		expect(addsUnsafeDetails("Go to http://evil.example.com/pay")).toBe(true);
		expect(addsUnsafeDetails("Go to pay-seek.com now")).toBe(true);
		expect(addsUnsafeDetails("Write to a@b.com")).toBe(true);
		expect(addsUnsafeDetails("Pay at seek-deposit.online today")).toBe(true);
		expect(addsUnsafeDetails("Visit seek-pay.co now")).toBe(true);
		expect(addsUnsafeDetails("Sort code 123456, then pay.")).toBe(true);
		expect(addsUnsafeDetails("Check https://www.gov.uk/private-renting and www.mydeposits.co.uk. Rent is £1,200.00.")).toBe(false);
		expect(addsUnsafeDetails("Write to a@b.com", "Seek reads a@b.com")).toBe(false);
	});

	it("falls back to the rules text when the model adds payment details from an e-mail subject", async () => {
		const none = {} as any;
		const llm = { isConfigured: () => true, complete: jest.fn().mockResolvedValue({ text: JSON.stringify({ advice: "Your landlord wrote about the rent. Transfer the deposit to sort code 12-34-56 today." }), provider: "gemini" }) };
		const service = new AiService(llm as any, none, none, none, none, none, none, none, none, none, { get: () => undefined } as any);
		jest.spyOn(service as any, "draftAdvice").mockResolvedValue({ title: "Bob: Deposit", advice: "Bob wrote on 1 Oct 2026. Reply here.", actions: [] });
		const result = await service.advice({ role: Role.STUDENT, _id: "u1" } as any, { topic: "inbox" } as any);
		expect(result.source).toBe("rules");
		expect(llm.complete.mock.calls[0][0].system).toMatch(/untrusted/);
	});

	it("sends only first name and surname initial of household members to the model", async () => {
		const none = {} as any;
		const member = (name: string) => ({ _id: { toString: () => "m" + name }, name, documents: [] });
		const application = { landlord: { toString: () => "l1" }, listing: "x", applicants: [member("Alice Martin"), member("Bob")] };
		const chain = (v: any) => ({ populate: () => chain(v), select: () => chain(v), lean: () => chain(v), exec: () => Promise.resolve(v) });
		const appModel = { findById: () => chain(application) };
		const listingModel = { findById: () => chain(null) };
		const service = new AiService(none, none, none, none, listingModel as any, none, none, appModel as any, none, none, { get: () => undefined } as any);
		const draft = await (service as any).householdAdvice({ _id: "l1", role: Role.LANDLORD_AGENCY }, "a1", new Date());
		expect(draft.advice).toMatch(/Alice Martin/);
		expect(JSON.stringify(draft.llm)).not.toMatch(/Martin/);
		expect(JSON.stringify(draft.llm)).toMatch(/Alice M\./);
	});

	it("answers 429 with a clear message after 10 AI calls a minute for one user", async () => {
		// The real storage: a mock hid that blockDuration 0 resets the count instead of blocking.
		const storage = new ThrottlerStorageService();
		const ai = { advice: jest.fn().mockResolvedValue({}) } as any;
		const controller = new AiController(ai, storage);
		const user = { _id: "u1" } as any;
		try {
			for (let i = 0; i < 10; i++) await controller.advice({ topic: "bills" } as any, user);
			for (let i = 0; i < 3; i++) await expect(controller.advice({ topic: "bills" } as any, user)).rejects.toMatchObject({ status: 429 });
			await expect(controller.advice({ topic: "bills" } as any, { _id: "u2" } as any)).resolves.toBeDefined();

			// Daily cap: 60, then refused for the rest of the day (minute window cleared between calls).
			const day = { _id: "u3" } as any;
			for (let i = 0; i < 62; i++) {
				(storage as any).storage.delete("ai-min:u3");
				const call = controller.advice({ topic: "bills" } as any, day);
				if (i < 60) await call; else await expect(call).rejects.toMatchObject({ status: 429 });
			}
		} finally {
			storage.onApplicationShutdown();
		}
	});
});

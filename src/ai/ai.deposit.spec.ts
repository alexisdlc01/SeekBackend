import { AiService, STUDENT_PROTECTS_DEPOSIT } from "./ai.service";
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

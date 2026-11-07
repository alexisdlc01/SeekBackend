import { Types } from "mongoose";
import { documentSignature, isValidSignature, renderAgreement, renderPrescribedInformation } from "./contract-documents";
import { ContractStatus, ContractTemplateKind, DeductionStatus } from "./contract.schema";
import { ContractsService } from "./contracts.service";

const data = {
	kind: ContractTemplateKind.ENGLAND_ASSURED_PERIODIC,
	title: "Assured periodic tenancy agreement",
	landlord: { name: "Priya <script>alert(1)</script>", email: "priya@example.com" },
	tenants: [{ name: "Maya" }, { name: "Tom" }],
	address: "14 Cotham Grove, Bristol",
	startDate: new Date("2026-09-01T00:00:00Z"),
	monthlyRent: 69500,
	depositAmount: 80100,
	depositScheme: "DPS"
};

describe("Seek agreement documents", () => {
	it("renders the England agreement with escaped values and household totals", () => {
		const html = renderAgreement(data);
		expect(html).toContain("assured periodic tenancy under the Housing Act 1988");
		expect(html).toContain("£1,390.00 a month");
		expect(html).toContain("On the 1st of each month");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("uses Welsh law and wording for an occupation contract", () => {
		const html = renderAgreement({ ...data, kind: ContractTemplateKind.WALES_STANDARD_OCCUPATION });
		expect(html).toContain("Renting Homes (Wales) Act 2016");
		expect(html).toContain("Contract-holders");
	});

	it("lists the deposit scheme in the prescribed information", () => {
		const html = renderPrescribedInformation(data);
		expect(html).toContain("Deposit Protection Service");
		expect(html).toContain("£1,602.00");
	});

	it("only accepts the signature for that contract and document", () => {
		const sig = documentSignature("secret", "abc", "agreement");
		expect(isValidSignature("secret", "abc", "agreement", sig)).toBe(true);
		expect(isValidSignature("secret", "abc", "prescribed-information", sig)).toBe(false);
		expect(isValidSignature("other", "abc", "agreement", sig)).toBe(false);
		expect(isValidSignature("secret", "abc", "agreement", "nope")).toBe(false);
	});
});

describe("ContractsService deductions", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const id = new Types.ObjectId().toString();
	const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [maya, tom], depositAmount: 80000 };

	function setup(contract: Record<string, unknown>) {
		let stored: any = { _id: new Types.ObjectId(), tenancy: tenancy._id, status: ContractStatus.SIGNED, ...contract };
		const contractModel = {
			findById: jest.fn(() => lean(stored)),
			findByIdAndUpdate: jest.fn((_id, update: any) => lean((stored = { ...stored, ...update.$set }))),
			findOneAndUpdate: jest.fn((filter: any, update: any) => {
				if ("deductions.responses" in filter && JSON.stringify(filter["deductions.responses"]) !== JSON.stringify(stored.deductions.responses)) {
					return lean(null);
				}
				stored = {
					...stored,
					deductions: { ...stored.deductions, responses: update.$set["deductions.responses"], status: update.$set["deductions.status"] }
				};
				return lean(stored);
			})
		};
		const tenancies = { findForLandlord: jest.fn().mockResolvedValue(tenancy), findForTenant: jest.fn().mockResolvedValue(tenancy) };
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const service = new ContractsService(
			contractModel as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			tenancies as any,
			notifications as any,
			{ get: () => "secret" } as any
		);
		return { service, notifications, contractModel, current: () => stored };
	}

	it("refuses deductions above the household's deposit", async () => {
		const { service } = setup({});
		await expect(
			service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 160001 }] }, { _id: tenancy.landlord } as any)
		).rejects.toThrow("more than the £1600.00 deposit");
	});

	it("is ACCEPTED only once every tenant agrees, and the landlord is told", async () => {
		const { service, notifications } = setup({});
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, { _id: tenancy.landlord } as any);
		const first = await service.respondToDeductions(id, { accept: true }, { _id: maya } as any);
		expect(first!.deductions!.status).toBe(DeductionStatus.PROPOSED);
		const second = await service.respondToDeductions(id, { accept: true }, { _id: tom } as any);
		expect(second!.deductions!.status).toBe(DeductionStatus.ACCEPTED);
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Tenants accepted the deductions" }));
	});

	it("refuses an answer built on a stale read instead of erasing another tenant's", async () => {
		const { service, contractModel, current } = setup({});
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, { _id: tenancy.landlord } as any);
		const stale = current();
		await service.respondToDeductions(id, { accept: false, note: "Already stained" }, { _id: maya } as any);
		contractModel.findById.mockReturnValueOnce(lean(stale));
		await expect(service.respondToDeductions(id, { accept: true }, { _id: tom } as any)).rejects.toThrow("Reload");
		expect(current().deductions.status).toBe(DeductionStatus.DISPUTED);
	});

	it("is DISPUTED as soon as one tenant disagrees", async () => {
		const { service } = setup({});
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, { _id: tenancy.landlord } as any);
		const result = await service.respondToDeductions(id, { accept: false, note: "Already stained" }, { _id: maya } as any);
		expect(result!.deductions!.status).toBe(DeductionStatus.DISPUTED);
	});
});

describe("ContractsService send", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const maya = new Types.ObjectId();
	const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [maya] };
	const contract = { _id: new Types.ObjectId(), tenancy: tenancy._id, status: ContractStatus.DRAFT, title: "Tenancy agreement" };

	it("emails each tenant as well as notifying them, and a mail failure does not undo the send", async () => {
		const contractModel = {
			findById: () => lean(contract),
			findOneAndUpdate: () => lean({ ...contract, status: ContractStatus.SENT })
		};
		const userModel = { find: () => lean([{ _id: maya, email: "maya@example.com", name: "Maya" }]) };
		const mail = { sendContractSentEmail: jest.fn().mockRejectedValue(new Error("Mailgun down")) };
		const notifications = { notifyMany: jest.fn() };
		const service = new ContractsService(
			contractModel as any, {} as any, {} as any, {} as any, {} as any,
			{ findForLandlord: jest.fn().mockResolvedValue(tenancy) } as any,
			notifications as any, { get: () => "secret" } as any, userModel as any, mail as any
		);
		const sent = await service.send(contract._id.toString(), { _id: tenancy.landlord } as any);
		expect(sent!.status).toBe(ContractStatus.SENT);
		expect(notifications.notifyMany).toHaveBeenCalled();
		expect(mail.sendContractSentEmail).toHaveBeenCalledWith("maya@example.com", "Maya", "Tenancy agreement", "/student/home");
	});
});

import { ConflictException } from "@nestjs/common";
import { Types } from "mongoose";
import { documentSignature, isValidSignature, renderAgreement, renderPrescribedInformation } from "./contract-documents";
import { ContractStatus, ContractTemplateKind, DeductionStatus } from "./contract.schema";
import { ContractsService } from "./contracts.service";
import { TenancyStatus } from "../tenancies/tenancy.enums";

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

	it("prints the Rent Smart Wales number and the HMO licence under their own labels in Wales only", () => {
		const html = renderAgreement({ ...data, kind: ContractTemplateKind.WALES_STANDARD_OCCUPATION, rentSmartWales: "RSW-12345", licenceNumber: "HMO-678" });
		expect(html).toContain("<td>Rent Smart Wales registration / licence</td><td>RSW-12345</td>");
		expect(html).toContain("<td>HMO / selective licence</td><td>HMO-678</td>");
		const england = renderAgreement({ ...data, rentSmartWales: "RSW-12345", licenceNumber: "HMO-678" });
		expect(england).not.toContain("RSW-12345");
	});

	it("lists each recorded tenant signature and does not claim the landlord signs", () => {
		const unsigned = renderAgreement(data);
		expect(unsigned).toContain("Each tenant signs this agreement electronically in Seek.");
		expect(unsigned).not.toContain("and the landlord sign");
		expect(unsigned).toContain("No signatures yet.");
		const html = renderAgreement({ ...data, signatures: [{ name: "Maya", signedAt: new Date("2026-09-02T08:05:00Z") }, { email: "tom@example.com", signedAt: new Date("2026-09-03T17:30:00Z") }] });
		expect(html).toContain("<td>Maya</td><td>Signed 2026-09-02 08:05 UTC</td>");
		expect(html).toContain("<td>tom@example.com</td><td>Signed 2026-09-03 17:30 UTC</td>");
		expect(html).not.toContain("No signatures yet.");
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

describe("ContractsService renderDocument", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

	it("shows who signed and when on the filed agreement", async () => {
		const maya = new Types.ObjectId();
		const contract = {
			_id: new Types.ObjectId(),
			tenancy: new Types.ObjectId(),
			title: "Assured periodic tenancy agreement",
			templateKind: ContractTemplateKind.ENGLAND_ASSURED_PERIODIC,
			signatures: [{ user: maya, signedAt: new Date("2026-09-02T08:05:00Z") }]
		};
		const tenancy = { landlord: { name: "Priya" }, tenants: [{ name: "Maya" }, { name: "Tom" }], startDate: new Date("2026-09-01"), monthlyRent: 50000, depositAmount: 50000 };
		const tenancyQuery: any = { populate: () => tenancyQuery, ...lean(tenancy) };
		const userModel = { find: jest.fn(() => lean([{ _id: maya, name: "Maya" }])) };
		const service = new ContractsService(
			{ findById: () => lean(contract) } as any, {} as any, {} as any, { findById: () => tenancyQuery } as any, {} as any,
			{} as any, {} as any, { get: () => "secret" } as any, userModel as any
		);
		const id = contract._id.toString();
		const html = await service.renderDocument(id, "agreement", documentSignature("secret", id, "agreement"));
		expect(html).toContain("<td>Maya</td><td>Signed 2026-09-02 08:05 UTC</td>");
		expect(html).not.toContain("<td>Tom</td><td>Signed");
		expect(userModel.find).toHaveBeenCalledWith({ _id: { $in: [maya] } }, { name: 1, email: 1 });
	});
});

describe("ContractsService deductions", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const id = new Types.ObjectId().toString();
	const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [maya, tom], depositAmount: 80000 };

	function setup(contract: Record<string, unknown>, deleted: Types.ObjectId[] = []) {
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
			{ get: () => "secret" } as any,
			{ find: jest.fn(() => lean(deleted.map(_id => ({ _id })))) } as any
		);
		return { service, notifications, contractModel, current: () => stored };
	}

	it("refuses deductions above the household's deposit", async () => {
		const { service } = setup({});
		await expect(
			service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 160001 }] }, { _id: tenancy.landlord } as any)
		).rejects.toThrow("more than the £1600.00 deposit");
	});

	it("proposes returning the whole deposit when the list is empty", async () => {
		const { service, current, notifications } = setup({});
		await service.proposeDeductions(id, { items: [] }, { _id: tenancy.landlord } as any);
		expect(current().deductions.total).toBe(0);
		expect(current().deductions.status).toBe(DeductionStatus.PROPOSED);
		expect(notifications.notifyMany).toHaveBeenCalledWith([expect.objectContaining({ title: "Your landlord will return the whole deposit" }), expect.anything()]);
	});

	it("does not wait for a co-tenant who deleted their account", async () => {
		const { service } = setup({}, [tom]);
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, { _id: tenancy.landlord } as any);
		const accepted = await service.respondToDeductions(id, { accept: true }, { _id: maya } as any);
		expect(accepted!.deductions!.status).toBe(DeductionStatus.ACCEPTED);
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

	it("lets the landlord re-propose after a dispute, clearing earlier answers", async () => {
		const { service, current } = setup({});
		const landlord = { _id: tenancy.landlord } as any;
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, landlord);
		await service.respondToDeductions(id, { accept: false, note: "Already stained" }, { _id: maya } as any);
		expect(current().deductions.status).toBe(DeductionStatus.DISPUTED);
		const result = await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 6000 }] }, landlord);
		expect(result!.deductions!.status).toBe(DeductionStatus.PROPOSED);
		expect(result!.deductions!.responses).toEqual([]);
	});

	it("refuses to re-propose deductions the tenants already accepted", async () => {
		const { service, current } = setup({});
		const landlord = { _id: tenancy.landlord } as any;
		await service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 12000 }] }, landlord);
		await service.respondToDeductions(id, { accept: true }, { _id: maya } as any);
		await service.respondToDeductions(id, { accept: true }, { _id: tom } as any);
		await expect(service.proposeDeductions(id, { items: [{ description: "Carpet", amount: 60000 }] }, landlord))
			.rejects.toThrow("These deductions are already accepted.");
		expect(current().deductions.total).toBe(12000);
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
	const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [maya], status: TenancyStatus.ACTIVE };
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

	it("refuses (409) while invited students have not accepted, leaving the draft unsent", async () => {
		const contractModel = { findById: () => lean(contract), findOneAndUpdate: jest.fn() };
		const notifications = { notifyMany: jest.fn() };
		const pending = { ...tenancy, status: TenancyStatus.PENDING_ACCEPTANCE, tenants: [], pendingTenants: [maya] };
		const service = new ContractsService(
			contractModel as any, {} as any, {} as any, {} as any, {} as any,
			{ findForLandlord: jest.fn().mockResolvedValue(pending) } as any,
			notifications as any, { get: () => "secret" } as any, {} as any, {} as any
		);
		await expect(service.send(contract._id.toString(), { _id: tenancy.landlord } as any)).rejects.toBeInstanceOf(ConflictException);
		expect(contractModel.findOneAndUpdate).not.toHaveBeenCalled();
		expect(notifications.notifyMany).not.toHaveBeenCalled();
	});
});

describe("ContractsService listForTenancy", () => {
	it("hides draft contracts from a tenant but not from the landlord", async () => {
		const maya = new Types.ObjectId();
		const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [maya] };
		const find = jest.fn().mockReturnValue({ populate: () => ({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }) });
		const service = new ContractsService(
			{ find } as any, {} as any, {} as any, {} as any, {} as any,
			{ findForMember: jest.fn().mockResolvedValue(tenancy) } as any,
			{} as any, { get: () => "secret" } as any, {} as any, {} as any
		);
		await service.listForTenancy(tenancy._id.toString(), { _id: maya } as any);
		await service.listForTenancy(tenancy._id.toString(), { _id: tenancy.landlord } as any);
		expect(find.mock.calls[0][0]).toEqual({ tenancy: tenancy._id, status: { $ne: ContractStatus.DRAFT } });
		expect(find.mock.calls[1][0]).toEqual({ tenancy: tenancy._id });
	});
});

describe("ContractsService signed email", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const tenancy = { _id: new Types.ObjectId(), landlord, tenants: [maya, tom], status: TenancyStatus.ACTIVE };

	function setup(signedBefore: Types.ObjectId[], mailError?: Error) {
		const contract = {
			_id: new Types.ObjectId(),
			tenancy: tenancy._id,
			status: ContractStatus.SENT,
			title: "Tenancy agreement",
			signatures: signedBefore.map(user => ({ user, signedAt: new Date() }))
		};
		const contractModel = {
			findById: () => lean(contract),
			findOneAndUpdate: jest.fn((_filter: any, update: any) =>
				lean(update.$push
					? { ...contract, signatures: [...contract.signatures, update.$push.signatures] }
					: { ...contract, status: ContractStatus.SIGNED })
			)
		};
		const userModel = {
			find: (filter: any) => lean(filter.deletedAt?.$ne === null ? [] : [
				{ _id: maya, email: "maya@example.com", name: "Maya" },
				{ _id: tom, email: "tom@example.com", name: "Tom" },
				{ _id: landlord, email: "priya@example.com", name: "Priya" }
			])
		};
		const mail = { sendContractSignedEmail: mailError ? jest.fn().mockRejectedValue(mailError) : jest.fn().mockResolvedValue(undefined) };
		const service = new ContractsService(
			contractModel as any, {} as any, {} as any, {} as any, {} as any,
			{ findForTenant: jest.fn().mockResolvedValue(tenancy), appendDocument: jest.fn() } as any,
			{ notify: jest.fn() } as any, { get: () => "secret" } as any, userModel as any, mail as any
		);
		return { service, contract, mail };
	}

	it("emails every tenant and the landlord once the last tenant signs, even if mail fails", async () => {
		const { service, contract, mail } = setup([maya], new Error("Mailgun down"));
		const signed = await service.sign(contract._id.toString(), { _id: tom } as any);
		expect(signed.status).toBe(ContractStatus.SIGNED);
		expect(mail.sendContractSignedEmail).toHaveBeenCalledTimes(3);
		expect(mail.sendContractSignedEmail).toHaveBeenCalledWith("maya@example.com", "Maya", "Tenancy agreement", "/student/home");
		expect(mail.sendContractSignedEmail).toHaveBeenCalledWith("priya@example.com", "Priya", "Tenancy agreement", "/contracts");
	});

	it("sends nothing on a partial signature", async () => {
		const { service, contract, mail } = setup([]);
		await service.sign(contract._id.toString(), { _id: maya } as any);
		expect(mail.sendContractSignedEmail).not.toHaveBeenCalled();
	});
});

describe("ContractsService after a tenant deletes their account", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

	it("completes signing and deductions that only waited for them, without emailing them", async () => {
		const [maya, tom, landlord] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
		const tenancy = { _id: new Types.ObjectId(), landlord, tenants: [maya, tom], status: TenancyStatus.ACTIVE };
		const sent = { _id: new Types.ObjectId(), tenancy: tenancy._id, status: ContractStatus.SENT, title: "Agreement", signatures: [{ user: maya, signedAt: new Date() }] };
		const deductions = { items: [], total: 12000, status: DeductionStatus.PROPOSED, proposedAt: new Date(), responses: [{ user: maya, accepted: true, at: new Date() }] };
		const signed = { _id: new Types.ObjectId(), tenancy: tenancy._id, status: ContractStatus.SIGNED, title: "Old agreement", signatures: [], deductions };
		const contractModel = {
			find: jest.fn(() => lean([sent, signed])),
			findOneAndUpdate: jest.fn((filter: any, update: any) =>
				lean(filter._id.equals(sent._id) ? { ...sent, ...update.$set } : { ...signed, deductions: { ...deductions, status: update.$set["deductions.status"] } })
			)
		};
		const userModel = {
			// Tom is already soft-deleted when the re-check runs.
			find: (filter: any) => lean(filter.deletedAt?.$ne === null ? [{ _id: tom }] : [
				{ _id: maya, email: "maya@example.com", name: "Maya" },
				{ _id: landlord, email: "priya@example.com", name: "Priya" }
			])
		};
		const notifications = { notify: jest.fn() };
		const mail = { sendContractSignedEmail: jest.fn().mockResolvedValue(undefined) };
		const service = new ContractsService(
			contractModel as any, {} as any, {} as any, { find: () => lean([tenancy]) } as any, {} as any,
			{ appendDocument: jest.fn() } as any, notifications as any, { get: () => "secret" } as any, userModel as any, mail as any
		);

		await service.settleForDeletedTenant(tom);

		const sets = contractModel.findOneAndUpdate.mock.calls.map(([, update]: any) => update.$set);
		expect(sets).toContainEqual(expect.objectContaining({ status: ContractStatus.SIGNED }));
		expect(sets).toContainEqual(expect.objectContaining({ "deductions.status": DeductionStatus.ACCEPTED }));
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ user: landlord, title: "Everyone has signed" }));
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ user: landlord, title: "Tenants accepted the deductions" }));
		expect(mail.sendContractSignedEmail.mock.calls.map(([email]: any) => email).sort()).toEqual(["maya@example.com", "priya@example.com"]);
	});
});

describe("ContractsService reminders", () => {
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const tenancy = { _id: new Types.ObjectId(), landlord, tenants: [maya, tom], status: TenancyStatus.ACTIVE };
	const now = new Date("2026-11-12T09:00:00Z");

	function setup(contract: Record<string, unknown>, tenancyStatus = TenancyStatus.ACTIVE) {
		let stored: any = {
			_id: new Types.ObjectId(),
			tenancy: tenancy._id,
			status: ContractStatus.SENT,
			title: "Tenancy agreement",
			signatures: [{ user: maya, signedAt: now }],
			lastRemindedAt: null,
			sentAt: new Date(now.getTime() - 4 * 86_400_000),
			...contract
		};
		const matches = (filter: any) =>
			filter.status === stored.status &&
			(!filter.autoReminderCount || !((stored.autoReminderCount ?? 0) >= filter.autoReminderCount.$not.$gte)) &&
			(!stored.lastRemindedAt || filter.$or[1].lastRemindedAt.$lte >= stored.lastRemindedAt);
		const contractModel = {
			findById: () => lean(stored),
			find: jest.fn((filter: any) => lean(matches(filter) && stored.sentAt <= filter.sentAt.$lte ? [{ _id: stored._id }] : [])),
			findOneAndUpdate: jest.fn((filter: any, update: any) =>
				lean(
					matches(filter)
						? (stored = { ...stored, ...update.$set, ...(update.$inc ? { autoReminderCount: (stored.autoReminderCount ?? 0) + update.$inc.autoReminderCount } : {}) })
						: null
				)
			)
		};
		const userModel = { find: jest.fn((query: any) => lean(query._id.$in.map((id: Types.ObjectId) => ({ _id: id, email: `${id}@example.com`, name: "T" })))) };
		const mail = { sendContractSentEmail: jest.fn().mockResolvedValue(undefined) };
		const current = { ...tenancy, status: tenancyStatus };
		const tenancyModel = { findById: () => lean(current) };
		const service = new ContractsService(
			contractModel as any, {} as any, {} as any, tenancyModel as any, {} as any,
			{ findForLandlord: jest.fn().mockResolvedValue(current), findForTenant: jest.fn().mockResolvedValue(current) } as any,
			{} as any, { get: () => "secret" } as any, userModel as any, mail as any
		);
		return { service, id: stored._id.toString(), mail, userModel };
	}

	it("emails only unsigned tenants, then refuses a second reminder within 24 hours", async () => {
		const { service, id, mail, userModel } = setup({});
		const reminded = await service.remind(id, { _id: landlord } as any);
		expect(reminded!.lastRemindedAt).toBeInstanceOf(Date);
		expect(userModel.find.mock.calls[0][0]._id.$in).toEqual([tom]);
		expect(mail.sendContractSentEmail).toHaveBeenCalledTimes(1);
		await expect(service.remind(id, { _id: landlord } as any)).rejects.toMatchObject({ status: 429 });
	});

	it("only reminds a SENT contract", async () => {
		const { service, id } = setup({ status: ContractStatus.SIGNED });
		await expect(service.remind(id, { _id: landlord } as any)).rejects.toThrow("waiting for signatures");
	});

	it("the daily sweep reminds stale contracts once, and skips recent ones", async () => {
		const stale = setup({});
		expect(await stale.service.remindStale(now)).toBe(1);
		expect(await stale.service.remindStale(now)).toBe(0);
		expect(stale.mail.sendContractSentEmail).toHaveBeenCalledTimes(1);

		const fresh = setup({ sentAt: new Date(now.getTime() - 86_400_000) });
		expect(await fresh.service.remindStale(now)).toBe(0);
	});

	it("stops reminders and signing once the tenancy has ended", async () => {
		const { service, id, mail } = setup({}, TenancyStatus.ENDED);
		expect(await service.remindStale(now)).toBe(0);
		await expect(service.remind(id, { _id: landlord } as any)).rejects.toMatchObject({ status: 409 });
		await expect(service.sign(id, { _id: tom } as any)).rejects.toMatchObject({ status: 409 });
		expect(mail.sendContractSentEmail).not.toHaveBeenCalled();
	});

	it("the daily sweep stops after 3 automatic reminders", async () => {
		const { service, mail } = setup({});
		const sent: number[] = [];
		for (let run = 0; run < 6; run += 1) sent.push(await service.remindStale(new Date(now.getTime() + run * 4 * 86_400_000)));
		expect(sent).toEqual([1, 1, 1, 0, 0, 0]);
		expect(mail.sendContractSentEmail).toHaveBeenCalledTimes(3);
	});
});

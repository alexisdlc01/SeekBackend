import { Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { ConnectorsService } from "./connectors.service";

const query = <T>(value: T) => {
	const chain: any = {
		sort: () => chain,
		select: () => chain,
		lean: () => chain,
		exec: () => Promise.resolve(value)
	};
	return chain;
};

describe("ConnectorsService.contactBook for landlords", () => {
	it("keeps applicants through the whole pipeline and links tenants to the application thread", async () => {
		const landlordId = new Types.ObjectId();
		const person = (stage: ApplicationStage) => ({
			_id: new Types.ObjectId(),
			stage,
			email: `${stage.toLowerCase()}@example.test`
		});
		const people = [
			ApplicationStage.SENT,
			ApplicationStage.VIEWED,
			ApplicationStage.OFFERED,
			ApplicationStage.SIGNED
		].map(person);
		const applications = people.map(p => ({
			_id: new Types.ObjectId(),
			stage: p.stage,
			landlord: landlordId,
			applicants: [p._id],
			conversation: new Types.ObjectId(),
			createdAt: new Date()
		}));
		const signed = applications[3];
		const tenancy = {
			_id: new Types.ObjectId(),
			landlord: landlordId,
			tenants: [people[3]._id],
			application: signed._id
		};
		const applicationModel = {
			// Mimics Mongo's `stage: { $in }` filter so the landlord query is exercised.
			find: jest.fn((filter: any) =>
				query(
					applications.filter(
						a => !filter.stage || filter.stage.$in.includes(a.stage)
					)
				)
			)
		};
		const none = {} as any;
		const service = new ConnectorsService(
			none,
			{ find: () => query([]) } as any,
			none,
			{ find: () => query([tenancy]) } as any,
			applicationModel as any,
			{
				find: () =>
					query(
						people.map(p => ({
							_id: p._id,
							name: p.stage,
							email: p.email
						}))
					)
			} as any,
			none,
			none,
			none,
			none,
			none
		);

		const book = await service.contactBook({
			_id: landlordId,
			role: Role.LANDLORD_AGENCY
		} as any);

		for (const stage of ["sent", "viewed", "offered"]) {
			expect(book.byEmail.get(`${stage}@example.test`)?.role).toBe(
				"APPLICANT"
			);
		}
		expect(book.byEmail.get("signed@example.test")).toMatchObject({
			role: "TENANT",
			conversationId: signed.conversation.toString()
		});
	});
});

describe("ConnectorsService.tenancyFor for students", () => {
	const current = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), listing: new Types.ObjectId() };
	const none = {} as any;
	const service = new ConnectorsService(
		none,
		none,
		none,
		{ findOne: () => query(current), findById: () => query(null) } as any,
		none,
		none,
		{ findById: () => query({ propertyTitle: "Elm Road" }) } as any,
		none,
		none,
		none,
		none
	);
	const student = { _id: new Types.ObjectId(), role: Role.STUDENT } as any;
	const mail = { subject: "Your new tenancy agreement", body: "" } as any;

	it("does not file mail from next year's landlord into the current tenancy", async () => {
		const nextYear = { role: "LANDLORD", userId: new Types.ObjectId().toString(), tenancyId: null, conversationId: null };
		await expect((service as any).tenancyFor(student, { contact: nextYear }, mail)).resolves.toBeNull();
	});

	it("still files mail with no Seek contact (bills, deposit schemes) into the current tenancy", async () => {
		const target = await (service as any).tenancyFor(student, { contact: null }, mail);
		expect(target.tenancy).toBe(current);
	});
});

import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { depositReceivedDate, TenanciesService } from "./tenancies.service";
import { TenancyStatus } from "./tenancy.enums";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Role } from "../auth/role.enum";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

describe("TenanciesService create / accept", () => {
	const landlordId = new Types.ObjectId();
	const listingId = new Types.ObjectId();
	const landlord = { _id: landlordId, role: Role.LANDLORD_AGENCY } as any;
	const listing = { _id: listingId, landlord: landlordId, propertyTitle: "14 Cotham Grove" };

	function setup() {
		const created: Record<string, unknown>[] = [];
		const tenancyModel = {
			create: jest.fn(async (doc: Record<string, unknown>) => {
				const value = { _id: new Types.ObjectId(), ...doc };
				created.push(value);
				return { _id: value._id, toObject: () => value };
			}),
			exists: jest.fn().mockResolvedValue(null),
			findById: jest.fn(),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
			findOneAndUpdate: jest.fn().mockReturnValue(lean(null))
		};
		const listingModel = { findById: jest.fn().mockReturnValue(lean(listing)) };
		const userModel = { countDocuments: jest.fn(async (q: any) => q._id.$in.length) };
		const applicationModel = { findById: jest.fn() };
		const rentSchedule = { ensureDefaultPlans: jest.fn() };
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const service = new TenanciesService(
			tenancyModel as any,
			listingModel as any,
			userModel as any,
			applicationModel as any,
			rentSchedule as any,
			notifications as any
		);
		jest.spyOn(service, "getDetail").mockResolvedValue({} as any);
		return { service, tenancyModel, listingModel, applicationModel, rentSchedule, notifications, created };
	}

	const base = { listing: listingId.toString(), startDate: "2026-12-01", monthlyRent: 69500 };

	it("refuses an application on someone else's listing (403)", async () => {
		const { service, applicationModel, listingModel } = setup();
		const otherListing = new Types.ObjectId();
		applicationModel.findById.mockReturnValue(
			lean({ _id: new Types.ObjectId(), listing: otherListing, applicants: [], stage: ApplicationStage.ACCEPTED })
		);
		listingModel.findById
			.mockReturnValueOnce(lean(listing))
			.mockReturnValueOnce(lean({ _id: otherListing, landlord: new Types.ObjectId() }));

		await expect(
			service.create({ ...base, application: new Types.ObjectId().toString() }, landlord)
		).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("refuses an application that is not ACCEPTED (400)", async () => {
		const { service, applicationModel, tenancyModel } = setup();
		applicationModel.findById.mockReturnValue(
			lean({ _id: new Types.ObjectId(), listing: listingId, applicants: [new Types.ObjectId()], stage: ApplicationStage.OFFERED })
		);

		await expect(
			service.create({ ...base, application: new Types.ObjectId().toString() }, landlord)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(tenancyModel.create).not.toHaveBeenCalled();
	});

	it("takes tenants from the application's applicants, never from the body", async () => {
		const { service, applicationModel, rentSchedule, created } = setup();
		const applicant = new Types.ObjectId();
		applicationModel.findById.mockReturnValue(
			lean({ _id: new Types.ObjectId(), listing: listingId, applicants: [applicant], stage: ApplicationStage.ACCEPTED })
		);

		await service.create(
			{ ...base, application: new Types.ObjectId().toString(), tenants: [new Types.ObjectId().toString()] },
			landlord
		);
		expect(created[0].tenants).toEqual([applicant]);
		expect(created[0].status).toBe(TenancyStatus.ACTIVE);
		expect(rentSchedule.ensureDefaultPlans).toHaveBeenCalledTimes(1);
	});

	it("a hand-made tenancy only invites, and schedules no rent", async () => {
		const { service, rentSchedule, notifications, created } = setup();
		const a = new Types.ObjectId().toString();
		const b = new Types.ObjectId().toString();

		await service.create({ ...base, tenants: [a, b] }, landlord);
		expect(created[0].status).toBe(TenancyStatus.PENDING_ACCEPTANCE);
		expect(created[0].tenants).toEqual([]);
		expect((created[0].pendingTenants as Types.ObjectId[]).map(String)).toEqual([a, b]);
		expect(rentSchedule.ensureDefaultPlans).not.toHaveBeenCalled();
		expect(notifications.notifyMany).toHaveBeenCalledTimes(1);
	});

	it("a pending hand-made tenancy with a deposit asks for the receipt date", async () => {
		const { service, created } = setup();
		await service.create({ ...base, tenants: [new Types.ObjectId().toString()], depositAmount: 50000 }, landlord);
		const items = service.complianceFor(created[0] as any, undefined);
		expect(created[0].status).toBe(TenancyStatus.PENDING_ACCEPTANCE);
		expect(items.map(item => item.kind)).toEqual(["DEPOSIT_NOT_YET_RECEIVED"]);
		expect(service.complianceFor({ ...(created[0] as any), status: TenancyStatus.ENDED }, undefined)).toEqual([]);
	});

	it("schedules rent only when the last invited student accepts", async () => {
		const { service, tenancyModel, rentSchedule } = setup();
		const a = new Types.ObjectId();
		const b = new Types.ObjectId();
		const tenancyId = new Types.ObjectId();
		const pending = {
			_id: tenancyId,
			listing: listingId,
			landlord: landlordId,
			tenants: [],
			pendingTenants: [a, b],
			status: TenancyStatus.PENDING_ACCEPTANCE,
			monthlyRent: 69500,
			depositAmount: 0
		};
		tenancyModel.findById.mockReturnValue(lean(pending));

		// First student: someone is still pending, nothing activates.
		await service.accept(tenancyId.toString(), { _id: a, role: Role.STUDENT } as any);
		expect(tenancyModel.updateOne).toHaveBeenCalledWith(
			{ _id: tenancyId, pendingTenants: a },
			{ $pull: { pendingTenants: a }, $addToSet: { tenants: a } }
		);
		expect(rentSchedule.ensureDefaultPlans).not.toHaveBeenCalled();

		// Last student: the guarded update flips the tenancy to ACTIVE.
		tenancyModel.findById.mockReturnValue(lean({ ...pending, tenants: [a], pendingTenants: [b] }));
		tenancyModel.findOneAndUpdate.mockReturnValue(
			lean({ ...pending, tenants: [a, b], pendingTenants: [], status: TenancyStatus.ACTIVE })
		);
		await service.accept(tenancyId.toString(), { _id: b, role: Role.STUDENT } as any);
		expect(tenancyModel.findOneAndUpdate).toHaveBeenLastCalledWith(
			{ _id: tenancyId, status: TenancyStatus.PENDING_ACCEPTANCE, pendingTenants: { $size: 0 } },
			{ $set: { status: TenancyStatus.ACTIVE } },
			{ new: true }
		);
		expect(rentSchedule.ensureDefaultPlans).toHaveBeenCalledTimes(1);
		expect(rentSchedule.ensureDefaultPlans.mock.calls[0][0].tenants).toEqual([a, b]);
	});

	it("starts an accepted application's tenancy on the listing's available date, not today", async () => {
		const { service, tenancyModel, listingModel, created } = setup();
		(tenancyModel as any).findOne = jest.fn().mockReturnValue(lean(null));
		const availableFrom = new Date(Date.now() + 24 * 24 * 60 * 60 * 1000);
		listingModel.findById.mockReturnValue(lean({ ...listing, monthlyRent: 1200, availableFrom }));

		await service.createFromApplication({
			_id: new Types.ObjectId(), listing: listingId, landlord: landlordId, applicants: [new Types.ObjectId()]
		});

		expect(created[0].startDate).toEqual(availableFrom);
	});

	it("refuses a student who was not invited", async () => {
		const { service, tenancyModel } = setup();
		tenancyModel.findById.mockReturnValue(
			lean({ _id: new Types.ObjectId(), tenants: [], pendingTenants: [new Types.ObjectId()], status: TenancyStatus.PENDING_ACCEPTANCE })
		);
		await expect(
			service.accept(new Types.ObjectId().toString(), { _id: new Types.ObjectId(), role: Role.STUDENT } as any)
		).rejects.toBeInstanceOf(ForbiddenException);
	});

	describe("one tenancy at a time (no overlapping dates)", () => {
		const student = new Types.ObjectId();
		const d = (iso: string) => new Date(iso);
		// Evaluates the helper's exists() filter against `others`, like Mongo would.
		const matches = (q: any, t: any) =>
			q.status.$in.includes(t.status)
			&& t.tenants.some((id: Types.ObjectId) => q.tenants.$in.some((x: Types.ObjectId) => x.equals(id)))
			&& (!q._id || !t._id.equals(q._id.$ne))
			&& (!q.startDate || t.startDate < q.startDate.$lt)
			&& (!q.$or || t.endDate == null || t.endDate > q.$or[1].endDate.$gt);
		function withExisting(status: TenancyStatus, startDate = d("2030-09-01"), endDate: Date | null = d("2031-06-30")) {
			const ctx = setup();
			const others = [{ _id: new Types.ObjectId(), tenants: [student], status, startDate, endDate }];
			ctx.tenancyModel.exists.mockImplementation(async (q: any) => (q.tenants ? others.find(t => matches(q, t)) ?? null : null));
			(ctx.tenancyModel as any).findOne = jest.fn().mockReturnValue(lean(null));
			return ctx;
		}
		const fromApplication = () => ({ _id: new Types.ObjectId(), listing: listingId, landlord: landlordId, applicants: [student] });
		const manual = (startDate: string, endDate?: string) => ({ ...base, startDate, endDate, tenants: [student.toString()] });

		it("refuses a second tenancy whose dates overlap a current one (409)", async () => {
			for (const status of [TenancyStatus.ACTIVE, TenancyStatus.PENDING_ACCEPTANCE]) {
				const { service, tenancyModel, listingModel } = withExisting(status);
				await expect(service.create(manual("2031-01-01", "2031-12-31"), landlord)).rejects.toThrow(ConflictException);
				await expect(service.create(manual("2030-01-01"), landlord)).rejects.toThrow("already has a tenancy for these dates");
				listingModel.findById.mockReturnValue(lean({ ...listing, availableFrom: d("2031-01-01"), availableUntil: d("2031-12-31") }));
				await expect(service.createFromApplication(fromApplication())).rejects.toThrow("Seek allows one tenancy at a time.");
				tenancyModel.findById.mockReturnValue(
					lean({ _id: new Types.ObjectId(), tenants: [], pendingTenants: [student], status: TenancyStatus.PENDING_ACCEPTANCE, startDate: d("2031-03-01"), endDate: null })
				);
				await expect(service.accept(new Types.ObjectId().toString(), { _id: student, role: Role.STUDENT } as any)).rejects.toThrow(ConflictException);
				expect(tenancyModel.create).not.toHaveBeenCalled();
				expect(tenancyModel.updateOne).not.toHaveBeenCalled();
			}
			// No end date = open-ended: it overlaps everything after its start.
			const { service } = withExisting(TenancyStatus.ACTIVE, d("2030-09-01"), null);
			await expect(service.create(manual("2035-09-01", "2036-06-30"), landlord)).rejects.toThrow(ConflictException);
		});

		it("allows next year's home starting on or after the current one ends", async () => {
			const { service, listingModel, created } = withExisting(TenancyStatus.ACTIVE);
			await service.create(manual("2031-06-30", "2032-06-30"), landlord);
			listingModel.findById.mockReturnValue(lean({ ...listing, availableFrom: d("2031-07-01"), availableUntil: d("2032-06-30") }));
			await service.createFromApplication(fromApplication());
			expect(created).toHaveLength(2);
		});

		it("lets an ENDED tenancy's dates be reused", async () => {
			const { service, created } = withExisting(TenancyStatus.ENDED);
			await service.create(manual("2031-01-01", "2031-12-31"), landlord);
			expect(created).toHaveLength(1);
		});
	});

	it("updateDeposit sets, clears or keeps the energy allowance", async () => {
		const { service, tenancyModel } = setup();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({ _id: new Types.ObjectId(), listing: listingId, monthlyRent: 69500, depositAmount: 50000 } as any);
		const deposit = { depositScheme: "DPS", depositReference: "DPS-1" } as any;
		const lastSet = () => tenancyModel.updateOne.mock.calls.at(-1)![1].$set;

		await service.updateDeposit("t", { ...deposit, energyAllowance: 20000 }, landlord);
		expect(lastSet().energyAllowance).toBe(20000);
		await service.updateDeposit("t", { ...deposit, energyAllowance: null }, landlord);
		expect(lastSet()).toHaveProperty("energyAllowance", null);
		await service.updateDeposit("t", deposit, landlord);
		expect(lastSet()).not.toHaveProperty("energyAllowance");
	});

	it("sets or clears only the allowance for the owning landlord", async () => {
		const { service, tenancyModel } = setup();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({ _id: new Types.ObjectId() } as any);
		jest.spyOn(service, "getDetail").mockResolvedValue({} as any);
		await service.updateEnergyAllowance("t", 15000, landlord);
		expect(tenancyModel.updateOne.mock.calls.at(-1)![1]).toEqual({ $set: { energyAllowance: 15000 } });
		await service.updateEnergyAllowance("t", null, landlord);
		expect(tenancyModel.updateOne.mock.calls.at(-1)![1]).toEqual({ $set: { energyAllowance: null } });
	});
});

describe("depositReceivedDate", () => {
	const now = new Date("2026-11-07T12:00:00Z");
	it("defaults to now, accepts the past and a few minutes of clock skew, refuses the future", () => {
		expect(depositReceivedDate(undefined, now)).toEqual(now);
		expect(depositReceivedDate("2026-10-12T00:00:00Z", now).toISOString()).toBe("2026-10-12T00:00:00.000Z");
		expect(depositReceivedDate("2026-11-07T12:03:00Z", now).toISOString()).toBe("2026-11-07T12:03:00.000Z");
		expect(() => depositReceivedDate("2026-11-12T12:00:00Z", now)).toThrow(BadRequestException);
	});
});

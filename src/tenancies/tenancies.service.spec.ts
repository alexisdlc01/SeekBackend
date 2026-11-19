import { BadRequestException, ConflictException, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Reflector } from "@nestjs/core";
import { Types } from "mongoose";
import { depositReceivedDate, earlyEndRefundAmount, TenanciesService } from "./tenancies.service";
import { InventoryStage, TenancyDocumentType, TenancyStatus } from "./tenancy.enums";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Role } from "../auth/role.enum";
import { TenanciesController } from "./tenancies.controller";
import { ROLE_KEY } from "../auth/decorators/role.decorator";
import { TEAM_SCOPES_KEY } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { RoleGuard } from "../auth/guards/role.guard";
import { AccessControlService } from "../shared/access-control.service";
import { isOfficialInventory } from "./tenancy.schema";
import { EndTenancyDto } from "./dto/end-tenancy.dto";
import { PaymentStatus } from "../payments/payment.enums";

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
		const contractModel = { exists: jest.fn().mockResolvedValue(null) };
		const rentSchedule = { ensureDefaultPlans: jest.fn() };
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const paymentModel = {
			deleteMany: jest.fn().mockResolvedValue({}),
			find: jest.fn().mockReturnValue(lean([])),
			findOneAndUpdate: jest.fn().mockReturnValue(lean(null)),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
			updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 })
		};
		const service = new TenanciesService(
			tenancyModel as any,
			listingModel as any,
			userModel as any,
			applicationModel as any,
			contractModel as any,
			rentSchedule as any,
			notifications as any,
			paymentModel as any
		);
		jest.spyOn(service, "getDetail").mockResolvedValue({} as any);
		return { service, tenancyModel, listingModel, applicationModel, contractModel, rentSchedule, notifications, paymentModel, created };
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

	it("refuses (409) an application tenancy once the listing's availability has ended, writing nothing", async () => {
		const { service, tenancyModel, listingModel, rentSchedule } = setup();
		(tenancyModel as any).findOne = jest.fn().mockReturnValue(lean(null));
		listingModel.findById.mockReturnValue(lean({ ...listing, availableFrom: new Date("2026-01-01"), availableUntil: new Date(Date.now() - 60_000) }));
		const application = { _id: new Types.ObjectId(), listing: listingId, landlord: landlordId, applicants: [new Types.ObjectId()] };

		await expect(service.createFromApplication(application)).rejects.toThrow(ConflictException);
		// The accept/offer pre-check goes through the same period, before the application is flipped.
		await expect(service.assertNoCurrentTenancy(application.applicants, listingId)).rejects.toThrow("availability has ended");
		expect(tenancyModel.create).not.toHaveBeenCalled();
		expect(rentSchedule.ensureDefaultPlans).not.toHaveBeenCalled();
	});

	it("returns the application's tenancy a concurrent accept created after the lookup, instead of a 409", async () => {
		const { service, tenancyModel } = setup();
		const application = { _id: new Types.ObjectId(), listing: listingId, landlord: landlordId, applicants: [new Types.ObjectId()] };
		const winner = { _id: new Types.ObjectId(), application: application._id, status: TenancyStatus.ACTIVE };
		// Lookup sees nothing; the other request then creates it, so the overlap check clashes with it.
		(tenancyModel as any).findOne = jest.fn().mockReturnValueOnce(lean(null)).mockReturnValue(lean(winner));
		tenancyModel.exists.mockResolvedValue(winner);

		await expect(service.createFromApplication(application)).resolves.toBe(winner);
		expect(tenancyModel.create).not.toHaveBeenCalled();
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

	it("refuses a new deposit amount once the Seek agreement is signed", async () => {
		const { service, tenancyModel, contractModel } = setup();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({ _id: new Types.ObjectId(), listing: listingId, monthlyRent: 69500, depositAmount: 50000 } as any);
		const deposit = { depositScheme: "DPS", depositReference: "DPS-1" } as any;
		contractModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		await expect(service.updateDeposit("t", { ...deposit, depositAmount: 60000 }, landlord)).rejects.toThrow(/already signed/);
		expect(tenancyModel.updateOne).not.toHaveBeenCalled();
		// scheme and reference are only known after signing, so an unchanged amount still goes through
		await service.updateDeposit("t", { ...deposit, depositAmount: 50000 }, landlord);
		expect(tenancyModel.updateOne).toHaveBeenCalled();
	});

	it("refuses a new deposit amount once one tenant has signed a SENT Seek agreement", async () => {
		const { service, tenancyModel, contractModel } = setup();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({ _id: new Types.ObjectId(), listing: listingId, monthlyRent: 69500, depositAmount: 50000 } as any);
		// Only a SENT contract with one signature exists: it matches the signatures clause, not status SIGNED.
		contractModel.exists.mockImplementation(async (filter: any) =>
			filter.$or?.some((clause: any) => "signatures.0" in clause) ? { _id: new Types.ObjectId() } : null
		);
		await expect(
			service.updateDeposit("t", { depositScheme: "DPS", depositReference: "DPS-1", depositAmount: 60000 } as any, landlord)
		).rejects.toThrow(/already signed/);
		expect(tenancyModel.updateOne).not.toHaveBeenCalled();
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

	it("keeps bank-transfer instructions landlord-only and changes no deposit fields", async () => {
		const { service, tenancyModel } = setup();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({ _id: new Types.ObjectId(), listing: listingId, monthlyRent: 69500, depositAmount: 50000 } as any);
		const handler = TenanciesController.prototype.bankTransferInstructions;
		expect(Reflect.getMetadata(ROLE_KEY, handler)).toEqual([Role.LANDLORD_AGENCY]);
		expect(Reflect.getMetadata(TEAM_SCOPES_KEY, handler)).toEqual([TeamScope.TENANCIES]);
		const context = {
			getHandler: () => handler,
			getClass: () => TenanciesController,
			switchToHttp: () => ({ getRequest: () => ({ user: { _id: new Types.ObjectId(), role: Role.STUDENT } }) })
		} as unknown as ExecutionContext;
		expect(new RoleGuard(new Reflector(), new AccessControlService()).canActivate(context)).toBe(false);
		await service.updateBankTransferInstructions("t", "  Pay account 12345678 with your surname  ", landlord);
		expect(tenancyModel.updateOne.mock.calls.at(-1)![1]).toEqual({
			$set: { bankTransferInstructions: "Pay account 12345678 with your surname" }
		});
	});

	describe("early tenancy end refunds", () => {
		const tenancyId = new Types.ObjectId();
		const paid = (amount: number, dueDate: string, coversMonths = 1) => ({
			_id: new Types.ObjectId(), tenancy: tenancyId, amount, dueDate: new Date(dueDate), coversMonths,
			kind: "RENT", status: "PAID", provider: "simulated", providerRef: "sim_paid",
			refundedAt: null, refundedAmount: 0
		});
		async function ending(payment: ReturnType<typeof paid>, endDate: string) {
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			ctx.paymentModel.find.mockImplementation((filter: any) => lean(filter.status?.$nin ? [] : [payment]));
			ctx.paymentModel.findOneAndUpdate.mockImplementation((_filter: any, update: any) => lean({ ...payment, ...update.$set }));
			await ctx.service.endTenancy(tenancyId.toString(), new Date(endDate), landlord);
			return ctx;
		}

		it("refunds the unused days when the tenancy ends mid-month", async () => {
			const payment = paid(62000, "2027-01-01");
			const { tenancyModel, paymentModel } = await ending(payment, "2027-01-16");
			expect(earlyEndRefundAmount(payment.amount, payment.dueDate, 1, new Date("2027-01-16"))).toBe(32000);
			expect(tenancyModel.updateOne).toHaveBeenCalledWith(
				{ _id: tenancyId, status: TenancyStatus.ACTIVE },
				{ $set: { endDate: new Date("2027-01-16T00:00:00.000Z"), status: TenancyStatus.ENDED } }
			);
			expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ dueDate: { $gte: new Date("2027-01-16T00:00:00.000Z") } }));
			expect(paymentModel.updateOne).toHaveBeenLastCalledWith(
				{ _id: payment._id, refundedAt: null },
				expect.objectContaining({ $set: expect.objectContaining({ refundedAmount: 32000, refundDue: false }) })
			);
		});

		it("refunds zero when the tenancy ends on the paid period boundary", async () => {
			const payment = paid(62000, "2027-01-01");
			const { paymentModel } = await ending(payment, "2027-02-01");
			expect(earlyEndRefundAmount(payment.amount, payment.dueDate, 1, new Date("2027-02-01"))).toBe(0);
			expect(paymentModel.updateOne).not.toHaveBeenCalled();
		});

		it("refunds full unused months plus the current month's unused days on an upfront plan", async () => {
			const payment = paid(300000, "2027-01-01", 3);
			const { paymentModel } = await ending(payment, "2027-02-15");
			expect(earlyEndRefundAmount(payment.amount, payment.dueDate, 3, new Date("2027-02-15"))).toBe(150000);
			expect(paymentModel.updateOne).toHaveBeenLastCalledWith(
				{ _id: payment._id, refundedAt: null },
				expect.objectContaining({ $set: expect.objectContaining({ refundedAmount: 150000 }) })
			);
		});

		it("atomically leaves an already claimed payment alone even when another date calculates a different refund", async () => {
			const payment = paid(62000, "2027-01-01");
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			ctx.paymentModel.find.mockImplementation((filter: any) => lean(filter.status?.$nin ? [] : [payment]));
			ctx.paymentModel.findOneAndUpdate.mockReturnValue(lean(null));

			await ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-20"), landlord);

			expect(ctx.paymentModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
				_id: payment._id, refundDue: { $ne: true }, autoRefund: { $ne: true }, refundAmount: { $in: [0, null] }
			});
			expect(ctx.paymentModel.updateOne).not.toHaveBeenCalled();
		});

		it("keeps a pending checkout row and flags its future rent for refund after settlement", async () => {
			const payment = { ...paid(62000, "2027-02-01"), status: "PENDING", provider: "stripe", providerRef: "cs_open" };
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			ctx.paymentModel.find.mockImplementation((filter: any) => lean(filter.status?.$nin || filter.status?.$in ? [] : [payment]));
			ctx.paymentModel.findOneAndUpdate.mockImplementation((_filter: any, update: any) => lean({ ...payment, ...update.$set }));

			await ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-16"), landlord);

			expect(ctx.paymentModel.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({ status: PaymentStatus.PENDING, dueDate: { $gte: new Date("2027-01-16T00:00:00.000Z") } }),
				[{ $set: { status: PaymentStatus.CANCELLED, refundDue: true, autoRefund: true, refundAmount: "$amount" } }]
			);
			expect(ctx.paymentModel.deleteMany.mock.calls[0][0].status).toEqual({ $nin: ["PAID", "PENDING", "CANCELLED"] });
			expect(ctx.paymentModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("closes the tenant's open Checkout session and intent on the landlord's account before deleting their rows", async () => {
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			const opened = [
				{ _id: new Types.ObjectId(), providerRef: "cs_open", stripeAccountId: "acct_1" },
				{ _id: new Types.ObjectId(), providerRef: "pi_failed", stripeAccountId: "acct_1" }
			];
			ctx.paymentModel.find.mockImplementation((filter: any) => lean(filter.providerRef ? opened : []));
			const calls: { url: string; account?: string }[] = [];
			const realFetch = global.fetch;
			const realKey = process.env.STRIPE_SECRET_KEY;
			process.env.STRIPE_SECRET_KEY = "sk_test_x";
			global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, account: (init?.headers as Record<string, string>)["Stripe-Account"] });
				// The intent can no longer be cancelled: logged, and the end still goes through.
				const ok = !url.includes("pi_failed");
				return { ok, status: ok ? 200 : 400, json: async () => (ok ? { id: "cs_open" } : { error: { message: "already succeeded" } }) } as Response;
			}) as never;
			try {
				await ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-16"), landlord);
			} finally {
				global.fetch = realFetch;
				process.env.STRIPE_SECRET_KEY = realKey;
			}

			expect(ctx.paymentModel.find.mock.calls[0][0]).toMatchObject({ status: { $nin: ["PAID", "PENDING", "CANCELLED"] }, providerRef: /^(cs|pi)_/ });
			expect(calls.map(call => [call.url.split("/v1")[1], call.account])).toEqual([
				["/checkout/sessions/cs_open/expire", "acct_1"],
				["/payment_intents/pi_failed/cancel", "acct_1"]
			]);
			expect(ctx.paymentModel.deleteMany).toHaveBeenCalledTimes(1);
		});

		it("tells each tenant once about the new end date", async () => {
			const maya = new Types.ObjectId();
			const tom = new Types.ObjectId();
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE, tenants: [maya, tom]
			} as any);

			await ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-16"), landlord);

			const sent = ctx.notifications.notifyMany.mock.calls[0][0];
			expect(sent.map((n: any) => n.user)).toEqual([maya, tom]);
			expect(sent[0]).toMatchObject({
				kind: "TENANCY_ENDED",
				title: "Your tenancy now ends on 16 January 2027",
				dedupeKey: `tenancy-ended:${tenancyId.toString()}:2027-01-16`
			});
		});

		it("stops before payment changes when another request already ended the tenancy", async () => {
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			ctx.tenancyModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

			await expect(ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-16"), landlord))
				.rejects.toBeInstanceOf(ConflictException);

			expect(ctx.tenancyModel.updateOne).toHaveBeenCalledWith(
				{ _id: tenancyId, status: TenancyStatus.ACTIVE },
				expect.anything()
			);
			expect(ctx.paymentModel.deleteMany).not.toHaveBeenCalled();
			expect(ctx.paymentModel.find).not.toHaveBeenCalled();
		});

		it("reduces an unpaid period spanning the end date to the days actually used", async () => {
			const payment = { ...paid(62000, "2027-01-01"), status: "SCHEDULED", seekFee: 620, payout: 61380 };
			const ctx = setup();
			jest.spyOn(ctx.service, "findForLandlord").mockResolvedValue({
				_id: tenancyId, landlord: landlordId, startDate: new Date("2027-01-01"), status: TenancyStatus.ACTIVE
			} as any);
			ctx.paymentModel.find.mockImplementation((filter: any) => lean(filter.status?.$nin ? [payment] : []));

			await ctx.service.endTenancy(tenancyId.toString(), new Date("2027-01-16"), landlord);

			expect(ctx.paymentModel.updateOne).toHaveBeenCalledWith(
				{ _id: payment._id, status: { $nin: ["PAID", "PENDING"] }, amount: 62000 },
				{ $set: { amount: 30000, seekFee: 300, payout: 29700 } }
			);
		});

		it("uses the tenancy anchor for a short-month due date", () => {
			expect(earlyEndRefundAmount(
				31000,
				new Date("2027-02-28"),
				1,
				new Date("2027-03-15"),
				new Date("2027-01-31")
			)).toBe(16000);
		});

		it("rejects invalid tenancy states and dates while preserving the ownership 403", async () => {
			const ctx = setup();
			const active = { _id: tenancyId, landlord: landlordId, startDate: new Date("2030-01-01"), endDate: new Date("2030-12-01"), status: TenancyStatus.ACTIVE };
			const find = jest.spyOn(ctx.service, "findForLandlord");
			find.mockResolvedValueOnce({ ...active, status: TenancyStatus.ENDED } as any);
			await expect(ctx.service.endTenancy(tenancyId.toString(), new Date("2030-06-01"), landlord)).rejects.toBeInstanceOf(ConflictException);

			for (const [tenancy, date] of [
				[active, "2029-12-31"],
				[active, "2031-01-01"],
				[{ ...active, startDate: new Date("2020-01-01"), endDate: null }, "2020-02-01"]
			] as const) {
				find.mockResolvedValueOnce(tenancy as any);
				await expect(ctx.service.endTenancy(tenancyId.toString(), new Date(date), landlord)).rejects.toBeInstanceOf(BadRequestException);
			}

			find.mockRestore();
			ctx.tenancyModel.findById.mockReturnValue(lean({ ...active, landlord: new Types.ObjectId() }));
			await expect(ctx.service.endTenancy(tenancyId.toString(), new Date("2030-06-01"), landlord)).rejects.toBeInstanceOf(ForbiddenException);
		});

		it("keeps the route landlord-only", () => {
			const handler = TenanciesController.prototype.end;
			expect(Reflect.getMetadata(ROLE_KEY, handler)).toEqual([Role.LANDLORD_AGENCY]);
			expect(Reflect.getMetadata(TEAM_SCOPES_KEY, handler)).toEqual([TeamScope.TENANCIES]);
		});
	});

	it("accepts only a YYYY-MM-DD end date", async () => {
		expect(await validate(plainToInstance(EndTenancyDto, { endDate: "2027-03-15" }))).toHaveLength(0);
		expect(await validate(plainToInstance(EndTenancyDto, { endDate: "2027-03-15T00:00:00Z" }))).not.toHaveLength(0);
	});

	it("files a housemate's agreement or certificate as OTHER, but keeps the landlord's type", async () => {
		const { service, tenancyModel } = setup();
		const student = { _id: new Types.ObjectId(), role: Role.STUDENT } as any;
		jest.spyOn(service, "findForMember").mockResolvedValue({ _id: new Types.ObjectId(), landlord: landlordId, tenants: [student._id] } as any);
		const doc = (type: TenancyDocumentType) => ({ type, title: "Signed tenancy agreement", url: "https://x.example/a" });
		const filedType = () => tenancyModel.updateOne.mock.calls.at(-1)![1].$push.documents.type;

		await service.addDocument("t", doc(TenancyDocumentType.TENANCY_AGREEMENT), student);
		expect(filedType()).toBe(TenancyDocumentType.OTHER);
		await service.addDocument("t", doc(TenancyDocumentType.GAS_SAFETY), student);
		expect(filedType()).toBe(TenancyDocumentType.OTHER);
		await service.addDocument("t", doc(TenancyDocumentType.COUNCIL_TAX_EXEMPTION), student);
		expect(filedType()).toBe(TenancyDocumentType.COUNCIL_TAX_EXEMPTION);
		await service.addDocument("t", doc(TenancyDocumentType.TENANCY_AGREEMENT), landlord);
		expect(filedType()).toBe(TenancyDocumentType.TENANCY_AGREEMENT);
	});

	it("lets a student add a check-out inventory photo to their own tenancy", async () => {
		const { service, tenancyModel } = setup();
		const student = { _id: new Types.ObjectId(), role: Role.STUDENT } as any;
		jest.spyOn(service, "findForMember").mockResolvedValue({ _id: new Types.ObjectId(), landlord: landlordId, tenants: [student._id] } as any);
		await service.addDocument("t", {
			type: TenancyDocumentType.INVENTORY,
			stage: InventoryStage.CHECK_OUT,
			title: "Bedroom wall",
			url: "https://x.example/wall.jpg"
		}, student);
		const stored = tenancyModel.updateOne.mock.calls.at(-1)![1].$push.documents;
		expect(stored).toMatchObject({
			type: TenancyDocumentType.INVENTORY,
			stage: InventoryStage.CHECK_OUT,
			uploadedBy: student._id,
			uploaderRole: Role.STUDENT
		});
		expect(isOfficialInventory(stored)).toBe(false);
	});

	it("defaults an inventory to check-in and never stores a stage on another document type", async () => {
		const { service, tenancyModel } = setup();
		jest.spyOn(service, "findForMember").mockResolvedValue({ _id: new Types.ObjectId(), landlord: landlordId, tenants: [] } as any);
		const baseDocument = { title: "Document", url: "https://x.example/document.pdf" };
		await service.addDocument("t", { ...baseDocument, type: TenancyDocumentType.INVENTORY }, landlord);
		const inventory = tenancyModel.updateOne.mock.calls.at(-1)![1].$push.documents;
		expect(inventory.stage).toBe(InventoryStage.CHECK_IN);
		expect(inventory).toMatchObject({ uploadedBy: landlord._id, uploaderRole: Role.LANDLORD_AGENCY });
		expect(isOfficialInventory(inventory)).toBe(true);
		await service.addDocument("t", { ...baseDocument, type: TenancyDocumentType.GAS_SAFETY, stage: InventoryStage.CHECK_OUT }, landlord);
		expect(tenancyModel.updateOne.mock.calls.at(-1)![1].$push.documents).not.toHaveProperty("stage");
	});

	it("lets only the owning landlord confirm an imported tenancy agreement", async () => {
		const { service, tenancyModel } = setup();
		const documentId = new Types.ObjectId();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({
			_id: new Types.ObjectId(),
			documents: [{ _id: documentId, type: TenancyDocumentType.TENANCY_AGREEMENT, confirmedByLandlord: false }]
		} as any);

		await service.confirmDocument("t", documentId.toString(), landlord);

		expect(tenancyModel.updateOne).toHaveBeenCalledWith(
			expect.objectContaining({ "documents._id": documentId }),
			{ $set: { "documents.$.confirmedByLandlord": true } }
		);
		const handler = TenanciesController.prototype.confirmDocument;
		expect(Reflect.getMetadata(ROLE_KEY, handler)).toEqual([Role.LANDLORD_AGENCY]);
		expect(Reflect.getMetadata(TEAM_SCOPES_KEY, handler)).toEqual([TeamScope.TENANCIES]);
	});

	it("does not confirm a non-contract document", async () => {
		const { service, tenancyModel } = setup();
		const documentId = new Types.ObjectId();
		jest.spyOn(service, "findForLandlord").mockResolvedValue({
			_id: new Types.ObjectId(),
			documents: [{ _id: documentId, type: TenancyDocumentType.INVENTORY }]
		} as any);

		await expect(service.confirmDocument("t", documentId.toString(), landlord)).rejects.toThrow("Tenancy agreement not found");
		expect(tenancyModel.updateOne).not.toHaveBeenCalled();
	});
});

describe("TenanciesService populated tenants", () => {
	it("never returns an invited (not yet accepted) student's email or university", async () => {
		const populate = jest.fn();
		const query: any = { populate, sort: () => query, lean: () => ({ exec: () => Promise.resolve([]) }) };
		populate.mockReturnValue(query);
		const tenancyModel = { find: jest.fn().mockReturnValue(query) };
		const service = new TenanciesService(tenancyModel as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

		await service.listForLandlord(new Types.ObjectId().toString());

		const pending = populate.mock.calls.find(([opts]) => opts.path === "pendingTenants")![0].select;
		expect(pending).not.toMatch(/email|universityDetails/);
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

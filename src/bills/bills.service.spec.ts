import { ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { BillsService } from "./bills.service";
import { BillStatus } from "./bill.schema";

const lean = <T>(value: T) => ({
	populate() {
		return this;
	},
	lean: () => ({ exec: () => Promise.resolve(value) })
});

describe("BillsService.markPaid", () => {
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const base = {
		_id: new Types.ObjectId(),
		tenancy: new Types.ObjectId(),
		amount: 3001,
		includedInRent: false,
		splitBetween: [maya, tom],
		paidShares: [] as Types.ObjectId[],
		status: BillStatus.DUE,
		paidAt: null
	};

	function setup(bill: typeof base) {
		let stored = { ...bill };
		const billModel = {
			findById: jest.fn(() => lean(stored)),
			findByIdAndUpdate: jest.fn((_id, update: any) => {
				if (update.$addToSet) stored = { ...stored, paidShares: [...stored.paidShares, update.$addToSet.paidShares] };
				if (update.$set) stored = { ...stored, ...update.$set };
				return lean(stored);
			})
		};
		const service = new BillsService(billModel as any, { findForMember: jest.fn().mockResolvedValue({ landlord }) } as any);
		return { service, billModel };
	}

	it("marks only the caller's share, then the whole bill once everyone has paid", async () => {
		const { service } = setup(base);
		const first = await service.markPaid(base._id.toString(), { _id: maya } as any);
		expect(first.status).toBe(BillStatus.DUE);
		expect(first.myPaid).toBe(true);
		expect(first.shares.map(share => [share.amount, share.paid])).toEqual([
			[1501, true],
			[1500, false]
		]);

		const second = await service.markPaid(base._id.toString(), { _id: tom } as any);
		expect(second.status).toBe(BillStatus.PAID);
		expect(second.shares.every(share => share.paid)).toBe(true);
	});

	it("lets the landlord settle the whole bill", async () => {
		const { service } = setup(base);
		const result = await service.markPaid(base._id.toString(), { _id: landlord } as any);
		expect(result.status).toBe(BillStatus.PAID);
		expect(result.myPaid).toBe(true);
	});

	it("refuses a flatmate outside the split", async () => {
		const { service, billModel } = setup(base);
		await expect(service.markPaid(base._id.toString(), { _id: new Types.ObjectId() } as any)).rejects.toBeInstanceOf(ForbiddenException);
		expect(billModel.findByIdAndUpdate).not.toHaveBeenCalled();
	});
});

describe("BillsService.create", () => {
	const maya = new Types.ObjectId();
	const tom = new Types.ObjectId();
	const tenancy = { _id: new Types.ObjectId(), tenants: [maya, tom] };

	function setup() {
		const billModel = {
			create: jest.fn((doc: any) => Promise.resolve({ ...doc, toObject: () => ({ ...doc }) }))
		};
		const service = new BillsService(billModel as any, { findForMember: jest.fn().mockResolvedValue(tenancy) } as any);
		return { service, billModel };
	}

	it("records the tenant who fronted a shared extra and marks their share paid in the same write", async () => {
		const { service, billModel } = setup();
		const view = await service.create(
			{ tenancy: tenancy._id.toString(), provider: "Cleaner", category: "OTHER" as any, amount: 6000 },
			{ _id: tom, name: "Tom" } as any
		);
		expect(billModel.create).toHaveBeenCalledTimes(1);
		expect(view.paidBy).toBe(tom.toString());
		expect(view.paidByName).toBe("Tom");
		expect(view.status).toBe(BillStatus.DUE);
		expect(view.shares.map(share => [share.user, share.amount, share.paid])).toEqual([
			[maya.toString(), 3000, false],
			[tom.toString(), 3000, true]
		]);
	});

	it("leaves emailed bills without a payer", async () => {
		const { service } = setup();
		const view = await service.create(
			{ tenancy: tenancy._id.toString(), provider: "Octopus", category: "ENERGY" as any, amount: 6000, source: "EMAIL" as any },
			{ _id: maya, name: "Maya" } as any
		);
		expect(view.paidBy).toBeNull();
		expect(view.shares.every(share => !share.paid)).toBe(true);
	});
});

describe("BillsService energy allowance", () => {
	it("reports allowance, usage and the overage split between the tenants", async () => {
		const tenants = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
		const tenancyId = new Types.ObjectId();
		const energy = {
			_id: new Types.ObjectId(),
			tenancy: tenancyId,
			category: "ENERGY",
			amount: 21401,
			periodStart: new Date("2026-10-01"),
			periodEnd: new Date("2026-10-31"),
			includedInRent: true,
			splitBetween: tenants,
			paidShares: [],
			status: BillStatus.PAID
		};
		const water = { ...energy, _id: new Types.ObjectId(), category: "WATER", amount: 4000 };
		const billModel = { find: jest.fn(() => ({ sort: () => lean([energy, water]) })) };
		const service = new BillsService(billModel as any, {
			findForMember: jest.fn().mockResolvedValue({ _id: tenancyId, tenants, energyAllowance: 20000 })
		} as any);

		const [energyView, waterView] = await service.listForTenancy(tenancyId.toString(), { _id: tenants[0] } as any);
		expect(energyView.allowance).toEqual({
			utility: "ENERGY",
			allowance: 20000,
			used: 21401,
			percentUsed: 107,
			overage: 1401,
			overagePerMember: tenants.map((user, index) => ({ user: user.toString(), amount: index === 0 ? 351 : 350 }))
		});
		expect(waterView.allowance).toBeNull();
	});
});

import { Types } from "mongoose";
import { RentScheduleService } from "./rent-schedule.service";
import { PaymentKind, PaymentStatus, PlanFrequency } from "./payment.enums";

describe("RentScheduleService.extend", () => {
	// Periodic tenancy: no end date, so the first schedule stops after 12 months (2027-11-01).
	const tenancy = {
		_id: new Types.ObjectId(),
		landlord: new Types.ObjectId(),
		tenants: [new Types.ObjectId()],
		startDate: new Date("2026-12-01T00:00:00Z"),
		endDate: null,
		monthlyRent: 60000
	};
	const tenant = tenancy.tenants[0];

	function setup(latestDueDate: string) {
		const latest = { dueDate: new Date(latestDueDate), coversMonths: 1 };
		const paymentModel = {
			findOne: jest.fn().mockReturnValue({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve(latest) }) }) }),
			insertMany: jest.fn((rows: unknown[]) => Promise.resolve(rows))
		};
		return { service: new RentScheduleService({} as any, paymentModel as any), paymentModel };
	}

	it("keeps rent coming after the first year of a periodic tenancy", async () => {
		const { service, paymentModel } = setup("2027-11-01T00:00:00Z");
		await service.extend(tenancy, tenant, PlanFrequency.MONTHLY, new Date("2027-11-15T09:00:00Z"));

		const rows = paymentModel.insertMany.mock.calls[0][0] as { dueDate: Date; status: PaymentStatus; amount: number }[];
		expect(rows.map(row => row.dueDate.toISOString().slice(0, 10))).toEqual([
			"2027-12-01", "2028-01-01", "2028-02-01", "2028-03-01", "2028-04-01", "2028-05-01",
			"2028-06-01", "2028-07-01", "2028-08-01", "2028-09-01", "2028-10-01", "2028-11-01"
		]);
		expect(rows.every(row => row.status === PaymentStatus.SCHEDULED && row.amount === 60000)).toBe(true);
	});

	it("adds nothing while a year is already scheduled", async () => {
		const { service, paymentModel } = setup("2028-11-01T00:00:00Z");
		await expect(service.extend(tenancy, tenant, PlanFrequency.MONTHLY, new Date("2027-11-15T09:00:00Z"))).resolves.toEqual([]);
		expect(paymentModel.insertMany).not.toHaveBeenCalled();
	});
});

describe("RentScheduleService.regenerate", () => {
	const tenancy = {
		_id: new Types.ObjectId(),
		landlord: new Types.ObjectId(),
		tenants: [new Types.ObjectId()],
		startDate: new Date("2026-09-01T00:00:00Z"),
		endDate: new Date("2027-08-31T00:00:00Z"),
		monthlyRent: 60000
	};
	const tenant = tenancy.tenants[0];
	type Row = { _id?: string; tenancy: Types.ObjectId; tenant: Types.ObjectId; dueDate: Date; coversMonths: number; status: PaymentStatus; providerRef?: string };

	// Just enough of Mongo's matching for the filters regenerate() sends.
	function matches(row: Row, filter: Record<string, any>): boolean {
		return Object.entries(filter).every(([key, cond]) => {
			if (key === "$or") return cond.some((sub: Record<string, any>) => matches(row, sub));
			const value = (row as any)[key];
			if (cond instanceof Types.ObjectId) return cond.equals(value);
			if (cond instanceof RegExp) return typeof value === "string" && cond.test(value);
			if (cond && typeof cond === "object") {
				return Object.entries(cond).every(([op, arg]: [string, any]) => {
					if (op === "$ne") return value !== arg;
					if (op === "$not") return !(typeof value === "string" && arg.test(value));
					if (op === "$gte") return value >= arg;
					if (op === "$gt") return value > arg;
					if (op === "$lt") return value < arg;
					throw new Error(`unsupported ${op}`);
				});
			}
			return value === cond;
		});
	}

	function setup(rows: Row[]) {
		const latest = (filter: Record<string, any>) =>
			rows.filter(row => matches(row, filter)).sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())[0] ?? null;
		const paymentModel = {
			findOne: (filter: Record<string, any>) => ({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve(latest(filter)) }) }) }),
			deleteMany: (filter: Record<string, any>) => {
				const kept = rows.filter(row => !matches(row, filter));
				rows.splice(0, rows.length, ...kept);
				return Promise.resolve();
			},
			insertMany: (inserted: Row[]) => {
				rows.push(...inserted);
				return Promise.resolve(inserted);
			}
		};
		return new RentScheduleService({} as any, paymentModel as any);
	}

	it.each([
		["a Checkout session was opened on January", { status: PaymentStatus.SCHEDULED, providerRef: "cs_test_123" }],
		["January was paid early", { status: PaymentStatus.PAID }]
	])("keeps every month billed when %s and the plan changes", async (_case, january) => {
		const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
			tenancy: tenancy._id,
			tenant,
			dueDate: new Date(Date.UTC(2026, 8 + i, 1)),
			coversMonths: 1,
			status: i < 3 ? PaymentStatus.PAID : PaymentStatus.SCHEDULED
		}));
		Object.assign(rows[4], january);
		const service = setup(rows);

		await service.regenerate(tenancy, tenant, PlanFrequency.SIX_MONTHS, new Date("2026-11-16T09:00:00Z"));

		const schedule = rows
			.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
			.map(row => `${row.dueDate.toISOString().slice(0, 7)}x${row.coversMonths}`);
		expect(schedule).toEqual([
			"2026-09x1", "2026-10x1", "2026-11x1", "2026-12x1", "2027-01x1", "2027-02x1", "2027-03x6"
		]);
	});

	it("schedules rent once when two plan changes and the hourly extend overlap", async () => {
		const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
			tenancy: tenancy._id,
			tenant,
			dueDate: new Date(Date.UTC(2026, 8 + i, 1)),
			coversMonths: 1,
			status: i < 3 ? PaymentStatus.PAID : PaymentStatus.SCHEDULED
		}));
		const service = setup(rows);
		const now = new Date("2026-11-16T09:00:00Z");

		await Promise.all([
			service.regenerate(tenancy, tenant, PlanFrequency.SIX_MONTHS, now),
			service.extend(tenancy, tenant, PlanFrequency.MONTHLY, now),
			service.regenerate(tenancy, tenant, PlanFrequency.SIX_MONTHS, now)
		]);

		const future = rows
			.filter(row => row.status === PaymentStatus.SCHEDULED)
			.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
		expect(future.map(row => `${row.dueDate.toISOString().slice(0, 7)}x${row.coversMonths}`)).toEqual(["2026-12x3", "2027-03x6"]);
		expect(future.reduce((total, row) => total + (row as any).amount, 0)).toBe(9 * 60000);
	});

	it("keeps an instalment due today that autopay may already have tried, so a retry reuses its idempotency key", async () => {
		const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
			_id: `row-${i}`,
			tenancy: tenancy._id,
			tenant,
			dueDate: new Date(Date.UTC(2026, 8 + i, 1)),
			coversMonths: 1,
			status: i < 2 ? PaymentStatus.PAID : PaymentStatus.SCHEDULED
		}));
		const service = setup(rows);

		// November is due today; autopay got no answer from Stripe and put it back to SCHEDULED.
		await service.regenerate(tenancy, tenant, PlanFrequency.SIX_MONTHS, new Date("2026-11-01T15:00:00Z"));

		expect(rows.some(row => row._id === "row-2")).toBe(true);
		const schedule = rows
			.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
			.map(row => `${row.dueDate.toISOString().slice(0, 7)}x${row.coversMonths}`);
		expect(schedule).toEqual(["2026-09x1", "2026-10x1", "2026-11x1", "2026-12x3", "2027-03x6"]);
	});
});

describe("RentScheduleService.applyHoldingCredit", () => {
	const application = new Types.ObjectId();
	const tenancy = {
		_id: new Types.ObjectId(),
		landlord: new Types.ObjectId(),
		tenants: [new Types.ObjectId()],
		startDate: new Date("2026-12-01T00:00:00Z"),
		endDate: new Date("2027-11-30T00:00:00Z"),
		monthlyRent: 69500,
		application
	};
	const tenant = tenancy.tenants[0];

	it("takes a holding deposit paid after acceptance off the first unpaid rent, once", async () => {
		const rent = [
			{ _id: new Types.ObjectId(), amount: 69500, dueDate: new Date("2026-12-01T00:00:00Z") },
			{ _id: new Types.ObjectId(), amount: 69500, dueDate: new Date("2027-01-01T00:00:00Z") }
		];
		const applied: { holdingDepositCredit: number }[] = [];
		const query = (rows: unknown[]) => ({ sort: () => query(rows), lean: () => ({ exec: () => Promise.resolve(rows) }) });
		const paymentModel = {
			find: jest.fn((filter: Record<string, any>) =>
				filter.kind === PaymentKind.HOLDING_DEPOSIT ? query([{ amount: 15000 }])
					: filter.holdingDepositCredit ? query(applied)
						: query(rent.filter(row => row.amount === 69500))
			),
			updateOne: jest.fn((filter: { _id: Types.ObjectId }, update: { $set: { amount: number; holdingDepositCredit: number } }) => {
				const row = rent.find(item => item._id.equals(filter._id))!;
				row.amount = update.$set.amount;
				applied.push({ holdingDepositCredit: update.$set.holdingDepositCredit });
				return Promise.resolve({ modifiedCount: 1 });
			})
		};
		const service = new RentScheduleService({} as any, paymentModel as any);
		const now = new Date("2026-11-16T09:00:00Z");

		await service.applyHoldingCredit(tenancy, tenant, now);
		await service.applyHoldingCredit(tenancy, tenant, now);

		expect(rent.map(row => row.amount)).toEqual([54500, 69500]);
		expect(paymentModel.updateOne).toHaveBeenCalledTimes(1);
		expect(paymentModel.updateOne.mock.calls[0][0]).toMatchObject({ status: PaymentStatus.SCHEDULED, providerRef: null, amount: 69500 });
		expect(paymentModel.updateOne.mock.calls[0][1].$set).toMatchObject({ amount: 54500, holdingDepositCredit: 15000 });
	});
});

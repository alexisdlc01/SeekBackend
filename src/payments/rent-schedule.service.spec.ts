import { Types } from "mongoose";
import { RentScheduleService } from "./rent-schedule.service";
import { PaymentStatus, PlanFrequency } from "./payment.enums";

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

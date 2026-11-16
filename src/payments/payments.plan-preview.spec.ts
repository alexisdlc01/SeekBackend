import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";
import { PaymentsService } from "./payments.service";
import { PaymentStatus, PlanFrequency } from "./payment.enums";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { Nation } from "../listings/enums/nation.enum";

describe("PaymentsService.previewPlan", () => {
	const tenant = { _id: new Types.ObjectId(), role: "student" } as any;
	const tenancy = { _id: new Types.ObjectId(), listing: new Types.ObjectId(), status: TenancyStatus.ACTIVE };
	const lean = (value: unknown) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
	const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

	function setup(nation: Nation) {
		const late = { _id: new Types.ObjectId(), dueDate: day("2026-11-01"), amount: 60000, coversMonths: 1, status: PaymentStatus.LATE, seekFee: 600, payout: 59400 };
		const paymentModel = {
			find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => lean([late]) }) }),
			exists: jest.fn().mockResolvedValue({ _id: late._id }),
			updateOne: jest.fn(),
			deleteMany: jest.fn(),
			insertMany: jest.fn()
		};
		const planModel = { findOne: jest.fn().mockReturnValue(lean({ frequency: PlanFrequency.MONTHLY })), updateOne: jest.fn() };
		const listingModel = { findById: jest.fn().mockReturnValue(lean({ nation, paymentPlans: [PlanFrequency.SIX_MONTHS, PlanFrequency.YEARLY] })) };
		const rentSchedule = {
			preview: jest.fn().mockResolvedValue({
				replaced: { status: PaymentStatus.SCHEDULED },
				added: [
					{ dueDate: day("2027-03-01"), amount: 360000, coversMonths: 6, seekFee: 3600, payout: 356400, status: PaymentStatus.SCHEDULED },
					{ dueDate: day("2026-12-01"), amount: 165000, coversMonths: 3, seekFee: 1650, payout: 163350, holdingDepositCredit: 15000, status: PaymentStatus.SCHEDULED }
				]
			}),
			regenerate: jest.fn()
		};
		const service = new PaymentsService(
			paymentModel as any, planModel as any, {} as any, listingModel as any, {} as any,
			{ findForTenant: jest.fn().mockResolvedValue(tenancy) } as any, rentSchedule as any, {} as any, {} as any, {} as any
		);
		return { service, paymentModel, planModel, rentSchedule };
	}

	it("lists kept and new payments in date order, without Seek's fee, and saves nothing", async () => {
		const { service, paymentModel, planModel, rentSchedule } = setup(Nation.SCOTLAND);

		const rows = await service.previewPlan(tenancy._id.toString(), PlanFrequency.SIX_MONTHS, tenant);

		expect(rows).toEqual([
			{ dueDate: day("2026-11-01"), amount: 60000, coversMonths: 1, holdingDepositCredit: 0, status: PaymentStatus.LATE },
			{ dueDate: day("2026-12-01"), amount: 165000, coversMonths: 3, holdingDepositCredit: 15000, status: PaymentStatus.SCHEDULED },
			{ dueDate: day("2027-03-01"), amount: 360000, coversMonths: 6, holdingDepositCredit: 0, status: PaymentStatus.SCHEDULED }
		]);
		// Kept rows exclude the ones the new plan replaces.
		expect(paymentModel.find.mock.calls[0][0]).toMatchObject({ $nor: [{ status: PaymentStatus.SCHEDULED }] });
		expect(rentSchedule.regenerate).not.toHaveBeenCalled();
		for (const write of [paymentModel.updateOne, paymentModel.deleteMany, paymentModel.insertMany, planModel.updateOne]) {
			expect(write).not.toHaveBeenCalled();
		}
	});

	it("keeps England's one-month cap: no half-year or full-year preview", async () => {
		const { service, rentSchedule } = setup(Nation.ENGLAND);

		await expect(service.previewPlan(tenancy._id.toString(), PlanFrequency.YEARLY, tenant)).rejects.toThrow(BadRequestException);
		expect(rentSchedule.preview).not.toHaveBeenCalled();
	});

	it("shows the current schedule when the plan would not change", async () => {
		const { service, rentSchedule } = setup(Nation.ENGLAND);

		const rows = await service.previewPlan(tenancy._id.toString(), PlanFrequency.MONTHLY, tenant);

		expect(rows.map(row => row.status)).toEqual([PaymentStatus.LATE]);
		expect(rentSchedule.preview).not.toHaveBeenCalled();
	});
});

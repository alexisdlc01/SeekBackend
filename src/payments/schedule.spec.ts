import { BadRequestException } from "@nestjs/common";
import { Nation } from "../listings/enums/nation.enum";
import { Types } from "mongoose";
import { PlanFrequency } from "./payment.enums";
import { RentScheduleService } from "./rent-schedule.service";
import {
	addBusinessDays,
	addMonths,
	allowedFrequencies,
	assertPlanAllowed,
	buildSchedule,
	computeFee,
	estimateNextPayout,
	firstTrackedDate,
	startOfUtcDay,
	restrictionReason
} from "./schedule";

describe("rent schedule", () => {
	it("takes a 0.5% Seek fee, rounded to the penny", () => {
		expect(computeFee(69500)).toEqual({ seekFee: 348, payout: 69152 });
		expect(computeFee(100)).toEqual({ seekFee: 1, payout: 99 });
		expect(computeFee(0)).toEqual({ seekFee: 0, payout: 0 });
	});

	it("allows only monthly plans in England, including listings without a nation", () => {
		expect(allowedFrequencies(Nation.ENGLAND)).toEqual([PlanFrequency.MONTHLY]);
		expect(allowedFrequencies(undefined)).toEqual([PlanFrequency.MONTHLY]);
		expect(restrictionReason(Nation.ENGLAND)).toMatch(/Renters' Rights Act/);
		expect(() => assertPlanAllowed(Nation.ENGLAND, PlanFrequency.SIX_MONTHS)).toThrow(BadRequestException);
	});

	it("allows longer plans in Wales and Scotland", () => {
		expect(allowedFrequencies(Nation.WALES)).toContain(PlanFrequency.YEARLY);
		expect(restrictionReason(Nation.SCOTLAND)).toBeNull();
		expect(() => assertPlanAllowed(Nation.WALES, PlanFrequency.SIX_MONTHS)).not.toThrow();
	});

	it("clamps month ends", () => {
		expect(addMonths(new Date("2027-01-31T00:00:00Z"), 1).toISOString()).toBe("2027-02-28T00:00:00.000Z");
	});

	it("schedules monthly instalments until the tenancy ends", () => {
		const schedule = buildSchedule({
			startDate: new Date("2026-09-01T00:00:00Z"),
			endDate: new Date("2027-06-30T00:00:00Z"),
			monthlyRent: 69500,
			frequency: PlanFrequency.MONTHLY,
			from: new Date("2026-11-06T00:00:00Z")
		});
		expect(schedule[0].dueDate.toISOString()).toBe("2026-12-01T00:00:00.000Z");
		expect(schedule.at(-1)!.dueDate.toISOString()).toBe("2027-06-01T00:00:00.000Z");
		expect(schedule).toHaveLength(7);
		expect(schedule.every(i => i.amount === 69500 && i.seekFee === 348)).toBe(true);
	});

	it("shortens the last six-month instalment to the months left", () => {
		const schedule = buildSchedule({
			startDate: new Date("2026-09-01T00:00:00Z"),
			endDate: new Date("2027-06-30T00:00:00Z"),
			monthlyRent: 50000,
			frequency: PlanFrequency.SIX_MONTHS,
			from: new Date("2026-09-01T00:00:00Z")
		});
		expect(schedule.map(i => i.coversMonths)).toEqual([6, 4]);
		expect(schedule[1].amount).toBe(200000);
	});

	it("starts a schedule for a tenancy that began earlier at the next due date, never in the past", () => {
		const startDate = new Date("2026-09-05T00:00:00Z");
		const now = new Date("2026-11-06T10:00:00Z");
		const from = firstTrackedDate(startDate, now);
		expect(from.toISOString()).toBe("2026-11-06T00:00:00.000Z");
		const schedule = buildSchedule({ startDate, endDate: null, monthlyRent: 69500, frequency: PlanFrequency.MONTHLY, from });
		expect(schedule[0].dueDate.toISOString()).toBe("2026-12-05T00:00:00.000Z");
		expect(schedule.every(i => i.dueDate >= startOfUtcDay(now))).toBe(true);
		// Due today still counts as the next due date.
		expect(
			buildSchedule({ startDate, endDate: null, monthlyRent: 69500, frequency: PlanFrequency.MONTHLY, from: firstTrackedDate(startDate, new Date("2026-11-05T18:00:00Z")) })[0].dueDate.toISOString()
		).toBe("2026-11-05T00:00:00.000Z");
		expect(firstTrackedDate(new Date("2027-01-10T00:00:00Z"), now).toISOString()).toBe("2027-01-10T00:00:00.000Z");
	});

	it("estimates the next payout two working days after the earliest paid or due rent", () => {
		expect(addBusinessDays(new Date("2026-11-06T00:00:00Z"), 2).toISOString()).toBe("2026-11-10T00:00:00.000Z");
		const now = new Date("2026-11-06T12:00:00Z");
		expect(estimateNextPayout({ paidAt: [], openDueDates: [], now })).toBeNull();
		const next = estimateNextPayout({
			paidAt: [new Date("2026-11-05T09:00:00Z")],
			openDueDates: [new Date("2026-12-01T00:00:00Z")],
			now
		});
		expect(next!.toISOString()).toBe("2026-11-09T09:00:00.000Z");
	});
});

describe("RentScheduleService.regenerate", () => {
	it("keeps an instalment whose Checkout session is open, so paying it is still recorded", async () => {
		const paymentModel = {
			deleteMany: jest.fn().mockResolvedValue({}),
			findOne: jest.fn().mockReturnValue({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }) }),
			insertMany: jest.fn().mockResolvedValue([])
		};
		const service = new RentScheduleService({} as any, paymentModel as any);
		const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId(), tenants: [], startDate: new Date("2026-09-01T00:00:00Z"), endDate: null, monthlyRent: 69500 };
		await service.regenerate(tenancy, new Types.ObjectId(), PlanFrequency.MONTHLY, new Date("2026-11-07T00:00:00Z"));
		const ref = paymentModel.deleteMany.mock.calls[0][0].providerRef;
		expect(ref?.$not?.test("cs_test_1")).toBe(true);
		expect(ref.$not.test("pi_1")).toBe(false);
	});
});

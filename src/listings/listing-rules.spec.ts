import { PlanFrequency } from "../payments/payment.enums";
import { Nation } from "./enums/nation.enum";
import { plansAfterNationChange, resolvePaymentPlans } from "./listing-rules";

describe("payment plans on a listing", () => {
	it("silently drops YEARLY on save instead of blocking the edit", () => {
		expect(resolvePaymentPlans(Nation.SCOTLAND, [PlanFrequency.SIX_MONTHS, PlanFrequency.YEARLY])).toEqual([PlanFrequency.SIX_MONTHS]);
		expect(resolvePaymentPlans(Nation.SCOTLAND, [PlanFrequency.YEARLY])).toEqual([PlanFrequency.MONTHLY]);
		expect(resolvePaymentPlans(Nation.SCOTLAND, [PlanFrequency.MONTHLY, PlanFrequency.SIX_MONTHS])).toEqual([PlanFrequency.MONTHLY, PlanFrequency.SIX_MONTHS]);
	});

	it("never keeps YEARLY when the nation changes", () => {
		expect(plansAfterNationChange(Nation.SCOTLAND, [PlanFrequency.YEARLY, PlanFrequency.SIX_MONTHS])).toEqual([PlanFrequency.SIX_MONTHS]);
	});
});

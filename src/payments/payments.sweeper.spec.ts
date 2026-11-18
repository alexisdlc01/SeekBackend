import { Logger } from "@nestjs/common";
import { PaymentsSweeper } from "./payments.sweeper";

describe("PaymentsSweeper", () => {
	it("still extends schedules when the offer-lapse clean-up fails, and logs the failure", async () => {
		const payments = {
			sweep: jest.fn().mockResolvedValue(undefined),
			refundDuePayments: jest.fn().mockResolvedValue(undefined),
			extendSchedules: jest.fn().mockResolvedValue(undefined)
		};
		const applications = { expireOffers: jest.fn().mockRejectedValue(new Error("timed out")) };
		const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		const sweeper = new PaymentsSweeper(payments as never, {} as never, applications as never);

		await (sweeper as any).run();

		expect(payments.extendSchedules).toHaveBeenCalledTimes(1);
		expect(payments.refundDuePayments).toHaveBeenCalledTimes(1);
		expect(logged).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		logged.mockRestore();
	});
});

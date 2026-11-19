import { Types } from "mongoose";
import { Logger } from "@nestjs/common";
import { PaymentProvider, PaymentStatus, PayoutStatus } from "./payment.enums";
import { proportionalRefund, refundPayment } from "./refund";
import { StripeApiError, StripeClient } from "./stripe";

describe("automatic payment refunds", () => {
	const base = {
		_id: new Types.ObjectId(),
		amount: 62000,
		status: PaymentStatus.PAID,
		provider: PaymentProvider.STRIPE,
		providerRef: "pi_paid",
		refundedAt: null,
		refundedAmount: 0
	};
	let paymentModel: { updateOne: jest.Mock };

	beforeEach(() => {
		paymentModel = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
		jest.restoreAllMocks();
	});

	it("records a simulated refund without calling Stripe", async () => {
		const stripe = jest.spyOn(StripeClient.prototype, "createRefund");
		await expect(refundPayment(paymentModel as any, { ...base, provider: PaymentProvider.SIMULATED, providerRef: "sim_paid" }, undefined))
			.resolves.toBe(true);
		expect(stripe).not.toHaveBeenCalled();
		expect(paymentModel.updateOne).toHaveBeenCalledWith(
			{ _id: base._id, refundedAt: null },
			expect.objectContaining({ $set: expect.objectContaining({ refundedAmount: 62000, refundRef: `sim_refund_${base._id}` }) })
		);
	});

	it("makes a partial Stripe refund with one stable key per payment", async () => {
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({ transfer_data: { destination: "acct_1" } } as never);
		const create = jest.spyOn(StripeClient.prototype, "createRefund").mockResolvedValue({ id: "re_1", status: "succeeded" });

		await expect(refundPayment(paymentModel as any, base, "sk_test", 32000)).resolves.toBe(true);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ payment_intent: "pi_paid", amount: 32000, reverse_transfer: true }),
			`seek-payment-refund-${base._id}`
		);
		expect(paymentModel.updateOne.mock.calls.at(-1)![1].$set).toMatchObject({ refundDue: false, refundedAmount: 32000, refundRef: "re_1" });
	});

	it("does nothing when the payment is already refunded", async () => {
		const create = jest.spyOn(StripeClient.prototype, "createRefund");
		await expect(refundPayment(paymentModel as any, { ...base, refundedAt: new Date(), refundedAmount: 62000 }, "sk_test"))
			.resolves.toBe(true);
		expect(create).not.toHaveBeenCalled();
		expect(paymentModel.updateOne).not.toHaveBeenCalled();
	});

	it("leaves an unsettled payment due until its paid webhook arrives", async () => {
		await expect(refundPayment(paymentModel as any, { ...base, status: PaymentStatus.PENDING }, "sk_test"))
			.resolves.toBe(false);
		expect(paymentModel.updateOne).not.toHaveBeenCalled();
	});

	it("keeps the refund due when Stripe rejects it", async () => {
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({} as never);
		jest.spyOn(StripeClient.prototype, "createRefund").mockRejectedValue(new StripeApiError("unavailable", 503));
		await expect(refundPayment(paymentModel as any, base, "sk_test")).resolves.toBe(false);
		expect(paymentModel.updateOne).not.toHaveBeenCalled();
	});

	it("keeps a pending Stripe refund outstanding, then completes it after Stripe succeeds", async () => {
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({} as never);
		jest.spyOn(StripeClient.prototype, "createRefund").mockResolvedValue({ id: "re_pending", status: "pending" });
		await expect(refundPayment(paymentModel as any, base, "sk_test", 32000)).resolves.toBe(true);
		expect(paymentModel.updateOne).toHaveBeenLastCalledWith(
			{ _id: base._id, refundedAt: null },
			{ $set: { refundRef: "re_pending", refundAmount: 32000 } }
		);

		jest.spyOn(StripeClient.prototype, "retrieveRefund").mockResolvedValue({ id: "re_pending", status: "succeeded" });
		await refundPayment(paymentModel as any, { ...base, refundRef: "re_pending" }, "sk_test", 32000);
		expect(paymentModel.updateOne.mock.calls.at(-1)![1].$set).toMatchObject({ refundedAt: expect.any(Date), refundedAmount: 32000 });
	});

	it("reverses the refunded share of an already transferred held payment", async () => {
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({} as never);
		jest.spyOn(StripeClient.prototype, "createRefund").mockResolvedValue({ id: "re_1", status: "succeeded" });
		const reversal = jest.spyOn(StripeClient.prototype, "createTransferReversal").mockResolvedValue({ id: "trr_1" });

		await refundPayment(paymentModel as any, {
			...base, payoutStatus: PayoutStatus.TRANSFERRED, transferRef: "tr_1", seekFee: 620
		}, "sk_test", 32000);

		expect(reversal).toHaveBeenCalledWith("tr_1", { amount: 31680 }, `seek-payment-refund-reversal-${base._id}`);
		expect(paymentModel.updateOne).toHaveBeenCalledWith(
			{ _id: base._id },
			{ $set: { reversalRef: "trr_1" } }
		);
	});

	it("saves the Stripe refund before retrying a failed transfer reversal", async () => {
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({} as never);
		const create = jest.spyOn(StripeClient.prototype, "createRefund").mockResolvedValue({ id: "re_saved", status: "succeeded" });
		const retrieve = jest.spyOn(StripeClient.prototype, "retrieveRefund").mockResolvedValue({ id: "re_saved", status: "succeeded" });
		const reversal = jest.spyOn(StripeClient.prototype, "createTransferReversal")
			.mockRejectedValueOnce(new StripeApiError("unavailable", 503))
			.mockResolvedValueOnce({ id: "trr_1" });
		const transferred = { ...base, payoutStatus: PayoutStatus.TRANSFERRED, transferRef: "tr_1", seekFee: 620 };

		await expect(refundPayment(paymentModel as any, transferred, "sk_test", 32000)).resolves.toBe(false);
		const saved = paymentModel.updateOne.mock.calls.find(([, update]) => update.$set?.refundRef === "re_saved");
		expect(saved?.[1].$set).toMatchObject({ refundRef: "re_saved", refundAmount: 32000 });
		expect(paymentModel.updateOne.mock.invocationCallOrder[0]).toBeLessThan(reversal.mock.invocationCallOrder[0]);

		await expect(refundPayment(paymentModel as any, { ...transferred, refundRef: "re_saved" }, "sk_test", 32000)).resolves.toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(retrieve).toHaveBeenCalledTimes(1);
		expect(reversal).toHaveBeenLastCalledWith("tr_1", { amount: 31680 }, `seek-payment-refund-reversal-${base._id}`);
	});

	it("refunds a direct charge on the landlord's account, Seek's fee included, without a transfer reversal", async () => {
		const calls: { url: string; account?: string; body: URLSearchParams }[] = [];
		jest.spyOn(global, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
			calls.push({ url, account: (init?.headers as Record<string, string>)["Stripe-Account"], body: new URLSearchParams(String(init?.body ?? "")) });
			return { ok: true, status: 200, json: async () => (url.includes("/payment_intents/") ? { id: "pi_paid", application_fee_amount: 620 } : { id: "re_1", status: "succeeded" }) } as Response;
		}) as never);

		await expect(refundPayment(paymentModel as any, { ...base, stripeAccountId: "acct_123" }, "sk_test", 32000)).resolves.toBe(true);
		const refund = calls.find(call => call.url.endsWith("/refunds"))!;
		expect(calls.every(call => call.account === "acct_123")).toBe(true);
		expect(refund.body.get("amount")).toBe("32000");
		expect(refund.body.get("refund_application_fee")).toBe("true");
		expect(refund.body.get("reverse_transfer")).toBeNull();
	});

	it("still reverses the transfer of a legacy destination charge on Seek's account", async () => {
		const calls: { url: string; account?: string; body: URLSearchParams }[] = [];
		jest.spyOn(global, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
			calls.push({ url, account: (init?.headers as Record<string, string>)["Stripe-Account"], body: new URLSearchParams(String(init?.body ?? "")) });
			return { ok: true, status: 200, json: async () => (url.includes("/payment_intents/") ? { id: "pi_paid", transfer_data: { destination: "acct_1" } } : { id: "re_1", status: "succeeded" }) } as Response;
		}) as never);

		await refundPayment(paymentModel as any, { ...base, stripeAccountId: null }, "sk_test");
		const refund = calls.find(call => call.url.endsWith("/refunds"))!;
		expect(calls.every(call => call.account === undefined)).toBe(true);
		expect(refund.body.get("reverse_transfer")).toBe("true");
	});

	it("keeps the proportional fee split exact to the penny", () => {
		const split = proportionalRefund(101, 50, 1);
		expect(split).toEqual({ tenantRefund: 50, landlordNet: 50, keptSeekFee: 1, transferReversal: 50 });
		expect(split.tenantRefund + split.landlordNet + split.keptSeekFee).toBe(101);
	});

	it("marks a terminal Stripe refund failed and logs it only once", async () => {
		const error = jest.spyOn(Logger.prototype, "error").mockImplementation();
		jest.spyOn(StripeClient.prototype, "retrievePaymentIntent").mockResolvedValue({} as never);
		jest.spyOn(StripeClient.prototype, "createRefund").mockResolvedValue({ id: "re_failed", status: "failed" });
		jest.spyOn(StripeClient.prototype, "retrieveRefund").mockResolvedValue({ id: "re_failed", status: "failed" });
		paymentModel.updateOne
			.mockResolvedValueOnce({ modifiedCount: 1 })
			.mockResolvedValueOnce({ modifiedCount: 1 })
			.mockResolvedValueOnce({ modifiedCount: 1 })
			.mockResolvedValueOnce({ modifiedCount: 0 });

		await refundPayment(paymentModel as any, base, "sk_test", 32000);
		await refundPayment(paymentModel as any, { ...base, refundRef: "re_failed" }, "sk_test", 32000);

		expect(paymentModel.updateOne).toHaveBeenCalledWith(
			{ _id: base._id, refundFailed: { $ne: true } },
			{ $set: { refundFailed: true, refundDue: false } }
		);
		expect(error.mock.calls.filter(([message]) => String(message).includes("automatic retries stopped"))).toHaveLength(1);
	});

	it("does not falsely complete a Checkout-session reference it cannot refund", async () => {
		await expect(refundPayment(paymentModel as any, { ...base, providerRef: "cs_paid" }, "sk_test")).resolves.toBe(false);
		expect(paymentModel.updateOne).not.toHaveBeenCalled();
	});
});

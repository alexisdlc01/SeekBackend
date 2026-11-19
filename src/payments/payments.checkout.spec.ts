import { createHmac } from "node:crypto";
import { BadRequestException, Logger } from "@nestjs/common";
import { Types } from "mongoose";
import { PaymentsService } from "./payments.service";
import { PaymentKind, PaymentProvider, PaymentStatus, PayoutStatus } from "./payment.enums";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
/** A landlord account able to take direct charges (and legacy transfers). */
const READY = { capabilities: { card_payments: "active", transfers: "active" } };
const CARD_NOT_READY = "Your landlord hasn't finished setting up card payments on Seek yet";

describe("PaymentsService.checkout (Stripe)", () => {
	const tenant = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const payment = {
		_id: new Types.ObjectId(),
		kind: PaymentKind.RENT,
		tenancy: new Types.ObjectId(),
		tenant,
		landlord,
		amount: 69500,
		seekFee: 695,
		payout: 68805,
		status: PaymentStatus.SCHEDULED,
		dueDate: new Date("2026-12-01T00:00:00Z"),
		providerRef: null
	};
	const calls: { url: string; body: URLSearchParams; key?: string; account?: string }[] = [];
	const openOffer = { stage: "OFFERED", offerExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000) };
	let offer: Record<string, unknown> = openOffer;
	let landlordUser: Record<string, unknown> = { stripeAccountId: "acct_123" };
	let lastPaymentModel: { updateOne: jest.Mock; find?: jest.Mock; findOneAndUpdate: jest.Mock };
	const realFetch = global.fetch;

	function setup(account: { capabilities: Record<string, string> } | null, autopay: boolean, stored: Record<string, unknown> = payment) {
		calls.length = 0;
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			const headers = (init?.headers as Record<string, string> | undefined) ?? {};
			calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")), key: headers["Idempotency-Key"], account: headers["Stripe-Account"] });
			const body = url.includes("/accounts/")
				? account ?? { error: { message: "No such account" } }
				: url.includes("/customers")
					? { id: "cus_1" }
					: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" };
			return { ok: !(url.includes("/accounts/") && !account), status: 200, json: async () => body } as Response;
		}) as never;
		const paymentModel = {
			findById: jest.fn().mockReturnValue(lean(stored)),
			findOneAndUpdate: jest.fn().mockReturnValue(lean(null)),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
		};
		const planModel = { findOne: jest.fn().mockReturnValue(lean({ autopay })) };
		const userModel = {
			findById: jest.fn((id: Types.ObjectId) =>
				lean(id.equals(landlord) ? landlordUser : { email: "maya@example.com", name: "Maya" })
			),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const tenancyModel = { findById: jest.fn().mockReturnValue({ populate: () => lean({ listing: { propertyTitle: "Cotham Flat" } }) }) };
		const config = { get: (key: string) => (key === "STRIPE_SECRET_KEY" ? "sk_test_x" : undefined) };
		lastPaymentModel = paymentModel;
		return new PaymentsService(
			paymentModel as any,
			planModel as any,
			tenancyModel as any,
			{} as any,
			userModel as any,
			{ assertNoCurrentTenancy: jest.fn() } as any,
			{} as any,
			{} as any,
			config as any,
			{ findById: jest.fn().mockReturnValue(lean(offer)) } as any
		);
	}

	afterAll(() => {
		global.fetch = realFetch;
	});

	it("refuses a holding deposit once its offer has lapsed, and closes an open offer's session with it", async () => {
		const holding = { ...payment, kind: PaymentKind.HOLDING_DEPOSIT, tenancy: undefined, application: new Types.ObjectId(), seekFee: 0, payout: 69500 };
		offer = { stage: "OFFERED", offerExpiresAt: new Date(Date.now() - 1000) };
		await expect(setup(READY, false, holding).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile"))
			.rejects.toThrow("no longer open");
		expect(calls).toHaveLength(0);
		offer = { stage: "VIEWED", offerExpiresAt: null };
		await expect(setup(READY, false, holding).pay(payment._id.toString(), { _id: tenant } as any)).rejects.toThrow("no longer open");

		const ends = new Date(Date.now() + 2 * 3_600_000);
		offer = { stage: "OFFERED", offerExpiresAt: ends };
		await setup(READY, false, holding).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
		const session = calls.find(call => call.url.endsWith("/checkout/sessions"))!.body;
		expect(Number(session.get("expires_at"))).toBe(Math.floor(ends.getTime() / 60_000) * 60);
		offer = openOffer;
	});

	it("refuses a holding deposit whose landlord has deleted their account or is suspended", async () => {
		const holding = { ...payment, kind: PaymentKind.HOLDING_DEPOSIT, tenancy: undefined, application: new Types.ObjectId(), seekFee: 0, payout: 69500 };
		for (const state of [{ deletedAt: new Date() }, { suspendedAt: new Date() }]) {
			landlordUser = { stripeAccountId: "acct_123", ...state };
			await expect(setup(READY, false, holding).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile"))
				.rejects.toThrow("no longer on Seek");
			await expect(setup(READY, false, holding).pay(payment._id.toString(), { _id: tenant } as any)).rejects.toThrow("no longer on Seek");
		}
		expect(calls).toHaveLength(0);
		landlordUser = { stripeAccountId: "acct_123" };
	});

	it("only sends the payer back to Seek: web app, app scheme, and Expo Go or localhost outside production", async () => {
		const service = setup(READY, false);
		const pay = (successUrl: string) => service.checkout(payment._id.toString(), { _id: tenant } as any, { successUrl }, "mobile");
		await expect(pay("https://evil.example/phish")).rejects.toThrow("Return URLs must point back to Seek");
		await expect(pay("exp://192.168.1.20:8081/--/pay?checkout=success")).resolves.toMatchObject({ mode: "stripe" });
		await expect(pay("http://localhost:5173/student/home/rent")).resolves.toMatchObject({ mode: "stripe" });
		await expect(pay("seekapp://pay")).resolves.toMatchObject({ mode: "stripe" });
	});

	it("sends Expo's seekapp:///pay to Stripe as seekapp://pay, keeping the session id placeholder", async () => {
		const service = setup(READY, false);
		await service.checkout(payment._id.toString(), { _id: tenant } as any, {
			successUrl: "seekapp:///pay?checkout=success&payment=p1&session_id={CHECKOUT_SESSION_ID}",
			cancelUrl: "seekapp:///pay?checkout=cancelled&payment=p1"
		}, "mobile");
		const session = calls.filter(call => call.url.endsWith("/checkout/sessions")).pop()!.body;
		expect(session.get("success_url")).toBe("seekapp://pay?checkout=success&payment=p1&session_id={CHECKOUT_SESSION_ID}");
		expect(session.get("cancel_url")).toBe("seekapp://pay?checkout=cancelled&payment=p1");
	});

	it("replaces an open session that returns somewhere else (opened on the web, paid from the app)", async () => {
		const service = setup(READY, false, { ...payment, providerRef: "cs_web" });
		const result = await service.checkout(payment._id.toString(), { _id: tenant } as any, { successUrl: "seekapp://pay?checkout=success" }, "mobile");
		expect(calls.some(call => call.url.includes("/checkout/sessions/cs_web")) && calls.some(call => call.url.endsWith("/expire"))).toBe(true);
		expect(calls.find(call => call.url.endsWith("/checkout/sessions"))!.body.get("success_url")).toBe("seekapp://pay?checkout=success");
		expect(result).toMatchObject({ sessionId: "cs_test_1" });
	});

	it("charges directly on the landlord's account, Seek's fee borne by the landlord, and saves the card there for autopay", async () => {
		const service = setup(READY, true);
		const result = await service.checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");

		expect(result).toMatchObject({ mode: "stripe", sessionId: "cs_test_1" });
		const create = calls.find(call => call.url.endsWith("/checkout/sessions"))!;
		const session = create.body;
		expect(create.account).toBe("acct_123");
		expect(session.get("mode")).toBe("payment");
		// The student pays exactly the rent; the fee comes off the landlord's side.
		expect(session.get("line_items[0][price_data][unit_amount]")).toBe("69500");
		expect(session.get("payment_intent_data[application_fee_amount]")).toBe("695");
		expect([...session.keys()].some(key => key.includes("transfer_data"))).toBe(false);
		expect(session.get("customer")).toBeNull();
		expect(session.get("customer_creation")).toBe("always");
		expect(session.get("payment_intent_data[setup_future_usage]")).toBe("off_session");
		expect(session.get("metadata[paymentId]")).toBe(payment._id.toString());
		expect(session.get("success_url")).toMatch(/^seekapp:\/\/rent-plan\?checkout=success/);
		// The account is recorded before Stripe is called, and nothing is ever HELD.
		const bind = lastPaymentModel.updateOne.mock.calls.findIndex(([, update]) => update.$set?.stripeAccountId === "acct_123");
		expect(lastPaymentModel.updateOne.mock.calls[bind][1].$set).toMatchObject({ stripeAccountId: "acct_123", payoutStatus: null });
		const createOrder = (global.fetch as jest.Mock).mock.invocationCallOrder[calls.indexOf(create)];
		expect(lastPaymentModel.updateOne.mock.invocationCallOrder[bind]).toBeLessThan(createOrder);
		for (const [, update] of lastPaymentModel.updateOne.mock.calls) expect(update.$set?.payoutStatus).not.toBe(PayoutStatus.HELD);
	});

	it("refuses card payment, writing nothing, while the landlord can't take card payments", async () => {
		// No account, or a legacy recipient-only one (transfers but no card_payments).
		for (const account of [null, { capabilities: { transfers: "active" } }]) {
			const service = setup(account, false);
			await expect(service.checkout(payment._id.toString(), { _id: tenant } as any, {}, undefined)).rejects.toThrow(CARD_NOT_READY);
			await expect(service.pay(payment._id.toString(), { _id: tenant } as any)).rejects.toThrow(CARD_NOT_READY);
			await expect(service.pay(payment._id.toString(), { _id: tenant } as any)).rejects.toBeInstanceOf(BadRequestException);
			expect(calls.every(call => call.url.includes("/accounts/"))).toBe(true);
			expect(lastPaymentModel.updateOne).not.toHaveBeenCalled();
		}
	});

	it("reuses an open session only on the same account; a legacy platform session is expired on Seek's account", async () => {
		const successUrl = "seekapp://pay?checkout=success";
		const cancelUrl = "seekapp://pay?checkout=cancelled";
		const respond = (stored: Record<string, unknown>) => {
			const service = setup(READY, false, stored);
			global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
				const headers = (init?.headers as Record<string, string> | undefined) ?? {};
				calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")), account: headers["Stripe-Account"] });
				const body = url.includes("/accounts/") ? READY
					: url.includes("/checkout/sessions/cs_old") ? { id: "cs_old", url: "https://checkout.stripe.com/c/pay/cs_old", status: "open", success_url: successUrl, cancel_url: cancelUrl }
					: { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new", status: "open" };
				return { ok: true, status: 200, json: async () => body } as Response;
			}) as never;
			return service.checkout(payment._id.toString(), { _id: tenant } as any, { successUrl, cancelUrl }, "mobile");
		};

		await expect(respond({ ...payment, providerRef: "cs_old", stripeAccountId: "acct_123" })).resolves.toMatchObject({ sessionId: "cs_old" });
		expect(calls.find(call => call.url.includes("/checkout/sessions/cs_old"))!.account).toBe("acct_123");
		expect(calls.some(call => call.url.endsWith("/expire"))).toBe(false);

		await expect(respond({ ...payment, providerRef: "cs_old" })).resolves.toMatchObject({ sessionId: "cs_new" });
		expect(calls.find(call => call.url.endsWith("/cs_old/expire"))!.account).toBeUndefined();
		expect(calls.find(call => call.url.endsWith("/checkout/sessions"))!.account).toBe("acct_123");
		expect(lastPaymentModel.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: { stripeAccountId: "acct_123", payoutStatus: null, providerRef: null } });
	});

	it("releases held payments to a ready account, minus Seek's 1% fee, tied to the original charge", async () => {
		const service = setup(READY, false);
		const held = { ...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, providerRef: "pi_1" };
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(held));
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
			const body = url.includes("/accounts/") ? { capabilities: { transfers: "active" } } : url.includes("/payment_intents/") ? { id: "pi_1", latest_charge: "ch_1" } : { id: "tr_1" };
			return { ok: true, status: 200, json: async () => body } as Response;
		}) as never;
		calls.length = 0;
		expect(await service.releaseHeldPayouts()).toBe(1);
		const transfer = calls.find(call => call.url.endsWith("/transfers"))!.body;
		expect(transfer.get("amount")).toBe(String(69500 - Math.round(69500 * 0.01)));
		expect(transfer.get("destination")).toBe("acct_123");
		expect(transfer.get("source_transaction")).toBe("ch_1");
		expect(lastPaymentModel.updateOne).toHaveBeenCalledWith(
			{ _id: payment._id, payoutStatus: PayoutStatus.HELD },
			{ $set: { payoutStatus: PayoutStatus.TRANSFERRED, transferRef: "tr_1", payoutReleaseStartedAt: null } }
		);
	});

	it("releases only the used-rent balance of a partially refunded held payment", async () => {
		const service = setup(READY, false);
		const held = {
			...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD,
			providerRef: "pi_1", refundedAmount: 32000, refundedAt: new Date()
		};
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(held));
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
			const body = url.includes("/accounts/") ? { capabilities: { transfers: "active" } } : url.includes("/payment_intents/") ? { latest_charge: "ch_1" } : { id: "tr_1" };
			return { ok: true, status: 200, json: async () => body } as Response;
		}) as never;
		calls.length = 0;

		await service.releaseHeldPayouts();

		expect(calls.find(call => call.url.endsWith("/transfers"))!.body.get("amount")).toBe("37125");
		expect(lastPaymentModel.find).toHaveBeenCalledWith(expect.not.objectContaining({ refundedAt: null }));
	});

	it("pays out nothing after a full refund of held money", async () => {
		const service = setup(READY, false);
		const held = {
			...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD,
			providerRef: "pi_1", refundedAmount: payment.amount, refundedAt: new Date()
		};
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(held));
		calls.length = 0;

		expect(await service.releaseHeldPayouts()).toBe(0);
		expect(calls.some(call => call.url.endsWith("/transfers"))).toBe(false);
	});

	it("does not release a row when an atomic refund claim wins the race", async () => {
		const service = setup(READY, false);
		const held = { ...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, providerRef: "pi_1" };
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(null));
		calls.length = 0;

		expect(await service.releaseHeldPayouts()).toBe(0);
		const claim = lastPaymentModel.findOneAndUpdate.mock.calls[0][0];
		expect(claim).toMatchObject({ _id: payment._id, payoutStatus: PayoutStatus.HELD });
		expect(claim.$or).toContainEqual({ payoutReleaseStartedAt: null, refundDue: { $ne: true } });
		expect(calls.some(call => call.url.endsWith("/transfers"))).toBe(false);
	});

	it("never releases a held deposit that is owed back to the student", async () => {
		const service = setup(READY, false);
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([]));
		await service.releaseHeldPayouts();
		const filter = lastPaymentModel.find.mock.calls[0][0];
		// Never a direct charge: that money is already the landlord's.
		expect(filter).toMatchObject({ payoutStatus: PayoutStatus.HELD, stripeAccountId: null });
		expect(filter.$or).toContainEqual({ payoutReleaseStartedAt: null, refundDue: { $ne: true } });
	});

	it("keeps an ambiguous payout locked so a refund cannot cross it", async () => {
		const service = setup(READY, false);
		const held = { ...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, providerRef: "pi_1", payoutReleaseStartedAt: new Date() };
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(held));
		global.fetch = jest.fn(async (url: string) => {
			if (url.includes("/accounts/")) return { ok: true, status: 200, json: async () => ({ capabilities: { transfers: "active" } }) } as Response;
			if (url.includes("/payment_intents/")) return { ok: true, status: 200, json: async () => ({ latest_charge: "ch_1" }) } as Response;
			throw new Error("timed out");
		}) as never;
		const error = jest.spyOn(Logger.prototype, "error").mockImplementation();

		expect(await service.releaseHeldPayouts()).toBe(0);
		await service.refundDuePayments();
		expect(lastPaymentModel.updateOne).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(expect.stringContaining(payment._id.toString()));
		error.mockRestore();
	});

	it("excludes failed refunds from both held-payout release filters", async () => {
		const service = setup(READY, false);
		const held = { ...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, providerRef: "pi_1" };
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		lastPaymentModel.findOneAndUpdate.mockReturnValue(lean(null));

		await service.releaseHeldPayouts();

		expect(lastPaymentModel.find.mock.calls[0][0]).toMatchObject({ refundFailed: { $ne: true } });
		expect(lastPaymentModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ refundFailed: { $ne: true } });
	});

	it("sweeps only refund rows explicitly marked for automatic handling", async () => {
		const service = setup(READY, false);
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([]));
		await service.refundDuePayments();
		expect(lastPaymentModel.find).toHaveBeenCalledWith(expect.objectContaining({ refundDue: true, autoRefund: true }));
	});

	it("keys the session on the whole request, so a changed autopay choice opens a new session", async () => {
		const sessionKey = async (autopay: boolean) => {
			await setup(READY, autopay).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
			return calls.find(call => call.url.endsWith("/checkout/sessions"))!.key;
		};
		const withAutopay = await sessionKey(true);
		expect(withAutopay).toMatch(/^seek-checkout-/);
		expect(await sessionKey(true)).toBe(withAutopay);
		expect(await sessionKey(false)).not.toBe(withAutopay);
	});

	it("sends no Seek fee on a holding deposit", async () => {
		const holding = { ...payment, kind: PaymentKind.HOLDING_DEPOSIT, tenancy: undefined, application: new Types.ObjectId(), seekFee: 0, payout: 69500 };
		const service = setup(READY, false, holding);
		jest.spyOn(service as any, "describe").mockResolvedValue("Holding deposit");
		await service.checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
		const create = calls.find(call => call.url.endsWith("/checkout/sessions"))!;
		expect(create.account).toBe("acct_123");
		expect(create.body.get("line_items[0][price_data][unit_amount]")).toBe("69500");
		expect(create.body.get("payment_intent_data[transfer_data][destination]")).toBeNull();
		expect(create.body.get("payment_intent_data[application_fee_amount]")).toBeNull();
	});
});

describe("PaymentsService confirm, webhook and duplicate charges (Stripe)", () => {
	const secret = "whsec_test";
	const connectSecret = "whsec_connect";
	const tenant = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const tenancy = new Types.ObjectId();
	const id = new Types.ObjectId();
	const realFetch = global.fetch;
	let doc: Record<string, any>;
	let stripeCalls: { method: string; url: string; body: URLSearchParams; account?: string }[];
	let session: Record<string, any>;
	let failExpire: boolean;
	let capabilities: Record<string, string>;

	function setup(stored: Record<string, unknown> = {}) {
		doc = { _id: id, kind: PaymentKind.RENT, tenancy, tenant, landlord, amount: 69500, seekFee: 695, payout: 68805, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-12-01T00:00:00Z"), providerRef: "cs_1", ...stored };
		session = { id: "cs_1", status: "complete", payment_status: "paid", amount_total: 69500, customer: "cus_1", metadata: { paymentId: id.toString() }, payment_intent: { id: "pi_checkout", payment_method: "pm_card" } };
		stripeCalls = [];
		failExpire = false;
		capabilities = { card_payments: "active", transfers: "active" };
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			const account = (init?.headers as Record<string, string> | undefined)?.["Stripe-Account"];
			stripeCalls.push({ method: init?.method ?? "GET", url, body: new URLSearchParams(String(init?.body ?? "")), account });
			if (url.includes("/expire") && failExpire) return { ok: false, status: 400, json: async () => ({ error: { message: "nope" } }) } as Response;
			const body = url.includes("/checkout/sessions/") ? session
				// A direct charge (read on the landlord's account) has no transfer_data; a legacy destination charge has.
				: url.includes("/payment_intents/") ? { id: url.split("/payment_intents/")[1], ...(account ? {} : { transfer_data: { destination: "acct_123" } }), application_fee_amount: 695 }
				: url.endsWith("/payment_intents") ? { id: "pi_autopay", status: "succeeded", client_secret: "pi_secret" }
				: url.includes("/accounts/") ? { capabilities }
				: { id: "re_1", status: "succeeded" };
			return { ok: true, status: 200, json: async () => body } as Response;
		}) as never;
		const matches = (filter: Record<string, any>) => Object.entries(filter).every(([key, value]) =>
			key === "_id" || (value && typeof value === "object" && "$ne" in value ? doc[key] !== value.$ne : doc[key] === value));
		const paymentModel = {
			findById: jest.fn(() => lean({ ...doc })),
			findOne: jest.fn(() => lean({ ...doc })),
			find: jest.fn(() => lean([{ ...doc }])),
			findOneAndUpdate: jest.fn((filter: Record<string, any>, update: { $set: Record<string, unknown> }) => {
				const hit = matches(filter);
				if (hit) Object.assign(doc, update.$set);
				return lean(hit ? { ...doc } : null);
			}),
			updateOne: jest.fn(async (filter: Record<string, any>, update: { $set: Record<string, unknown> }) => {
				const hit = matches(filter);
				if (hit) Object.assign(doc, update.$set);
				return { modifiedCount: hit ? 1 : 0 };
			})
		};
		const planModel = {
			find: jest.fn(() => lean([{ tenancy, tenant, paymentMethodId: "pm_card", stripeCustomerId: "cus_1" }])),
			findOne: jest.fn(() => lean({ notifyEveryPayment: true })),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const userModel = {
			findById: jest.fn(() => lean({ name: "Maya", stripeCustomerId: "cus_1", stripeAccountId: "acct_123" })),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const tenancyModel = {
			findById: jest.fn().mockReturnValue({ populate: () => lean({ listing: { propertyTitle: "Cotham Flat" } }) }),
			findOne: jest.fn(() => lean({ _id: tenancy, application: doc.application }))
		};
		const rentSchedule = { applyHoldingCredit: jest.fn().mockResolvedValue(undefined) };
		const notifications = { notify: jest.fn().mockResolvedValue(true) };
		const config = { get: (key: string) => ({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: secret, STRIPE_CONNECT_WEBHOOK_SECRET: connectSecret } as Record<string, string>)[key] };
		const service = new PaymentsService(paymentModel as any, planModel as any, tenancyModel as any, {} as any, userModel as any, {} as any, rentSchedule as any, notifications as any, config as any, {} as any);
		const webhook = (event: unknown, key = secret) => {
			const body = JSON.stringify(event);
			const t = Math.floor(Date.now() / 1000);
			return service.handleWebhook(Buffer.from(body), `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`);
		};
		const refunds = () => stripeCalls.filter(call => call.url.endsWith("/refunds"));
		return { service, webhook, refunds, notifications, planModel, paymentModel, rentSchedule };
	}

	afterAll(() => {
		global.fetch = realFetch;
	});

	it("refuses another payment's session on confirm", async () => {
		const { service } = setup();
		session.metadata = { paymentId: new Types.ObjectId().toString() };
		await expect(service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any)).rejects.toThrow(BadRequestException);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("leaves the payment unpaid and refunds the charge when Stripe's amount differs", async () => {
		const { service, webhook, refunds } = setup();
		session.amount_total = 100;
		await service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any);
		await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_checkout", amount: 100, metadata: { paymentId: id.toString() } } } });
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
		expect(refunds()).toHaveLength(2);
		expect(refunds().map(call => call.body.get("payment_intent"))).toEqual(["pi_checkout", "pi_checkout"]);
		expect(refunds()[0].body.get("reverse_transfer")).toBe("true");
	});

	it("marks paid once and sends one receipt when confirm and the webhook both arrive", async () => {
		const { service, webhook, refunds, notifications } = setup();
		await service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any);
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_checkout" } } });
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_checkout" });
		expect(notifications.notify.mock.calls.filter(([n]) => n.kind === "RENT_RECEIPT")).toHaveLength(1);
		expect(refunds()).toHaveLength(0);
	});

	it("puts a holding deposit whose webhook lands after the offer was accepted toward the tenancy's rent", async () => {
		const application = new Types.ObjectId();
		const { webhook, rentSchedule } = setup({ kind: PaymentKind.HOLDING_DEPOSIT, tenancy: undefined, application, amount: 15000 });
		session.amount_total = 15000;
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_checkout" } } });
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_checkout" } } });
		expect(doc.status).toBe(PaymentStatus.PAID);
		expect(rentSchedule.applyHoldingCredit).toHaveBeenCalledTimes(1);
		expect(rentSchedule.applyHoldingCredit).toHaveBeenCalledWith(expect.objectContaining({ _id: tenancy, application }), tenant);
	});

	it("rejects a webhook with a bad signature", async () => {
		const { webhook } = setup();
		await expect(webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } }, "whsec_other")).rejects.toThrow(BadRequestException);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("saves the autopay card when only the webhook confirms (its payment_intent is a bare id)", async () => {
		const { webhook, planModel } = setup({ stripeAccountId: "acct_123" });
		await webhook({ type: "checkout.session.completed", account: "acct_123", data: { object: { id: "cs_1", payment_intent: "pi_checkout", metadata: { paymentId: id.toString() }, payment_status: "paid" } } }, connectSecret);
		expect(planModel.updateOne).toHaveBeenCalledWith(expect.objectContaining({ autopay: true }), { $set: { paymentMethodId: "pm_card", stripeCustomerId: "cus_1" } });
	});

	it("refunds a second charge on an already-paid payment, taking it back from the landlord", async () => {
		const { webhook, service, refunds } = setup({ status: PaymentStatus.PAID, providerRef: "pi_autopay" });
		await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_checkout", amount: 69500, metadata: { paymentId: id.toString() } } } });
		await service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any);
		expect(refunds()).toHaveLength(2);
		const refund = refunds()[0].body;
		expect(refund.get("payment_intent")).toBe("pi_checkout");
		expect(refund.get("reverse_transfer")).toBe("true");
		expect(refund.get("refund_application_fee")).toBe("true");
		expect(doc.providerRef).toBe("pi_autopay");
	});

	it("keeps the Checkout session when a card is declined on its page", async () => {
		const { webhook, notifications } = setup();
		await webhook({ type: "payment_intent.payment_failed", data: { object: { id: "pi_checkout", amount: 69500, metadata: { paymentId: id.toString() } } } });
		expect(doc).toMatchObject({ status: PaymentStatus.SCHEDULED, providerRef: "cs_1" });
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("keeps post-tenancy pending rent cancelled when its Stripe intent later fails", async () => {
		const { webhook, notifications } = setup({ status: PaymentStatus.CANCELLED, providerRef: "pi_cancelled" });

		await webhook({
			type: "payment_intent.payment_failed",
			data: { object: { id: "pi_cancelled", amount: 69500, metadata: { paymentId: id.toString() } } }
		});

		expect(doc.status).toBe(PaymentStatus.CANCELLED);
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("returns no url for a payment already paid", async () => {
		const { service } = setup({ status: PaymentStatus.PAID });
		await expect(service.checkout(id.toString(), { _id: tenant } as any, {}, "web")).resolves.toMatchObject({ url: null, status: PaymentStatus.PAID });
	});

	it("puts autopay back to SCHEDULED when Stripe doesn't answer, and charges on the next sweep", async () => {
		const { service } = setup({ dueDate: new Date("2026-11-01T00:00:00Z"), providerRef: null });
		const answering = global.fetch;
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/payment_intents")) throw new DOMException("The operation timed out.", "TimeoutError");
			return (answering as any)(url, init);
		}) as never;
		await expect((service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"))).resolves.toBeUndefined();
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);

		global.fetch = answering;
		await (service as any).sweepStripeAutopay(new Date("2026-11-07T01:00:00Z"));
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_autopay" });
	});

	it("closes an open Checkout session before autopay charges, and skips when it can't", async () => {
		const { service } = setup({ dueDate: new Date("2026-11-01T00:00:00Z") });
		session.status = "open";
		await (service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"));
		const urls = stripeCalls.map(call => call.url);
		expect(urls.findIndex(url => url.endsWith("/cs_1/expire"))).toBeLessThan(urls.findIndex(url => url.endsWith("/payment_intents")));
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_autopay" });

		const second = setup({ dueDate: new Date("2026-11-01T00:00:00Z") });
		session.status = "open";
		failExpire = true;
		await (second.service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"));
		expect(stripeCalls.some(call => call.url.endsWith("/payment_intents"))).toBe(false);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("closes an open held Checkout session before POST /pay opens a PaymentIntent, and skips when it can't", async () => {
		const { service } = setup({ payoutStatus: PayoutStatus.HELD });
		session.status = "open";
		await service.pay(id.toString(), { _id: tenant } as any);
		const urls = stripeCalls.map(call => call.url);
		expect(urls.findIndex(url => url.endsWith("/cs_1/expire"))).toBeGreaterThan(-1);
		expect(urls.findIndex(url => url.endsWith("/cs_1/expire"))).toBeLessThan(urls.findIndex(url => url.endsWith("/payment_intents")));

		const second = setup({ payoutStatus: PayoutStatus.HELD });
		session.status = "open";
		failExpire = true;
		await expect(second.service.pay(id.toString(), { _id: tenant } as any)).rejects.toThrow("could not be started");
		expect(stripeCalls.some(call => call.url.endsWith("/payment_intents"))).toBe(false);
		expect(doc).toMatchObject({ providerRef: "cs_1", payoutStatus: PayoutStatus.HELD });

		const third = setup({ payoutStatus: PayoutStatus.HELD });
		await third.service.pay(id.toString(), { _id: tenant } as any);
		expect(stripeCalls.some(call => call.url.endsWith("/payment_intents"))).toBe(false);
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_checkout", payoutStatus: PayoutStatus.HELD });
	});

	it("settles a direct charge from the Connect endpoint, reading its session on the landlord's account", async () => {
		const { webhook } = setup({ stripeAccountId: "acct_123" });
		await webhook({ type: "checkout.session.completed", account: "acct_123", data: { object: { id: "cs_1", payment_intent: "pi_checkout" } } }, connectSecret);
		expect(stripeCalls.find(call => call.url.includes("/checkout/sessions/cs_1"))!.account).toBe("acct_123");
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_checkout" });

		const intent = setup({ stripeAccountId: "acct_123", providerRef: "pi_direct", status: PaymentStatus.PENDING });
		await intent.webhook({ type: "payment_intent.succeeded", account: "acct_123", data: { object: { id: "pi_direct", amount: 69500, metadata: { paymentId: id.toString() } } } }, connectSecret);
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_direct" });
	});

	it("never settles a payment from another account's event, and refunds any money taken there", async () => {
		const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
		const forged = setup({ stripeAccountId: "acct_123", providerRef: "pi_direct", status: PaymentStatus.PENDING });
		await forged.webhook({ type: "payment_intent.payment_failed", account: "acct_evil", data: { object: { id: "pi_direct", amount: 69500, metadata: { paymentId: id.toString() } } } }, connectSecret);
		expect(forged.refunds()).toHaveLength(0);
		await forged.webhook({ type: "payment_intent.succeeded", account: "acct_evil", data: { object: { id: "pi_evil", amount: 69500, metadata: { paymentId: id.toString() } } } }, connectSecret);
		// A legacy intent on Seek's account outliving its row's move to the landlord's: refunded on Seek's account.
		await forged.webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_old", amount: 69500, metadata: { paymentId: id.toString() } } } });
		expect(doc.status).toBe(PaymentStatus.PENDING);
		expect(forged.refunds().map(call => [call.body.get("payment_intent"), call.account])).toEqual([["pi_evil", "acct_evil"], ["pi_old", undefined]]);
		expect(forged.refunds().every(call => call.body.get("reason") === "duplicate")).toBe(true);

		const legacy = setup();
		await legacy.webhook({ type: "checkout.session.completed", account: "acct_123", data: { object: { id: "cs_1" } } }, connectSecret);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
		expect(legacy.refunds().map(call => [call.body.get("payment_intent"), call.account])).toEqual([["pi_checkout", "acct_123"]]);
		const unpaid = setup();
		session.payment_status = "unpaid";
		await unpaid.webhook({ type: "checkout.session.completed", account: "acct_123", data: { object: { id: "cs_1" } } }, connectSecret);
		expect(unpaid.refunds()).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored"));
		warn.mockRestore();
	});

	it("closes a legacy /pay intent on Seek's account before opening Checkout on the landlord's, or settles it if it already went through", async () => {
		const withIntent = (status: string) => {
			const ctx = setup({ providerRef: "pi_old", provider: PaymentProvider.STRIPE, status: PaymentStatus.PENDING });
			const answering = global.fetch;
			global.fetch = jest.fn(async (url: string, init?: RequestInit) =>
				url.endsWith("/payment_intents/pi_old")
					? ({ ok: true, status: 200, json: async () => ({ id: "pi_old", status, amount: 69500 }) } as Response)
					: (answering as any)(url, init)) as never;
			return ctx;
		};
		await withIntent("requires_action").service.checkout(id.toString(), { _id: tenant } as any, {}, "mobile");
		const urls = stripeCalls.map(call => call.url);
		expect(stripeCalls.find(call => call.url.endsWith("/pi_old/cancel"))!.account).toBeUndefined();
		expect(urls.findIndex(url => url.endsWith("/pi_old/cancel"))).toBeLessThan(urls.findIndex(url => url.endsWith("/checkout/sessions")));
		expect(doc.stripeAccountId).toBe("acct_123");

		const paid = await withIntent("succeeded").service.checkout(id.toString(), { _id: tenant } as any, {}, "mobile");
		expect(paid.status).toBe(PaymentStatus.PAID);
		expect(stripeCalls.some(call => call.url.endsWith("/checkout/sessions") || call.url.endsWith("/cancel"))).toBe(false);
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_old" });
		expect(doc.stripeAccountId).toBeUndefined();
	});

	it("never saves a card from a legacy Checkout on Seek's account for autopay", async () => {
		const { webhook, planModel } = setup();
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
		expect(doc.status).toBe(PaymentStatus.PAID);
		expect(planModel.updateOne).not.toHaveBeenCalled();
	});

	it("still settles a legacy platform charge from the platform endpoint, and rejects a signature matching neither secret", async () => {
		const { webhook } = setup({ providerRef: "pi_legacy", status: PaymentStatus.PENDING });
		await expect(webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_legacy", amount: 69500 } } }, "whsec_other")).rejects.toThrow(BadRequestException);
		expect(doc.status).toBe(PaymentStatus.PENDING);
		await webhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_legacy", amount: 69500, metadata: { paymentId: id.toString() } } } });
		expect(doc.status).toBe(PaymentStatus.PAID);
	});

	it("refunds a mismatched direct charge on the landlord's account, with Seek's fee and no transfer reversal", async () => {
		const { webhook, refunds } = setup({ stripeAccountId: "acct_123", providerRef: "pi_direct", status: PaymentStatus.PENDING });
		await webhook({ type: "payment_intent.succeeded", account: "acct_123", data: { object: { id: "pi_direct", amount: 100, metadata: { paymentId: id.toString() } } } }, connectSecret);
		expect(doc.status).toBe(PaymentStatus.PENDING);
		expect(refunds()).toHaveLength(1);
		expect(refunds()[0].account).toBe("acct_123");
		expect(refunds()[0].body.get("refund_application_fee")).toBe("true");
		expect(refunds()[0].body.get("reverse_transfer")).toBeNull();
	});

	it("charges autopay directly on the landlord's account with the plan's customer, and skips a landlord not ready", async () => {
		const { service } = setup({ dueDate: new Date("2026-11-01T00:00:00Z"), providerRef: null });
		await (service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"));
		const create = stripeCalls.find(call => call.url.endsWith("/payment_intents"))!;
		expect(create.account).toBe("acct_123");
		expect(create.body.get("amount")).toBe("69500");
		expect(create.body.get("application_fee_amount")).toBe("695");
		expect(create.body.get("customer")).toBe("cus_1");
		expect([...create.body.keys()].some(key => key.startsWith("transfer_data"))).toBe(false);
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, stripeAccountId: "acct_123", payoutStatus: null });

		const notReady = setup({ dueDate: new Date("2026-11-01T00:00:00Z"), providerRef: null });
		capabilities = { transfers: "active" };
		await (notReady.service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"));
		expect(stripeCalls.some(call => call.url.endsWith("/payment_intents"))).toBe(false);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
		expect(notReady.paymentModel.updateOne).not.toHaveBeenCalled();
		// The tenant hears autopay didn't run and the landlord is nudged, once per payment.
		expect(notReady.notifications.notify.mock.calls.map(([n]) => [n.user, n.dedupeKey])).toEqual([
			[tenant, `autopay-skipped:${id.toString()}`],
			[landlord, `autopay-skipped:${id.toString()}`]
		]);
		expect(notReady.notifications.notify.mock.calls[0][0].body).toContain("autopay didn't run");
	});

	it("never charges a card saved on Seek's account before direct charges (no plan customer)", async () => {
		const { service, planModel } = setup({ dueDate: new Date("2026-11-01T00:00:00Z"), providerRef: null });
		planModel.find.mockReturnValue(lean([{ tenancy, tenant, paymentMethodId: "pm_platform" } as any]));
		await (service as any).sweepStripeAutopay(new Date("2026-11-07T00:00:00Z"));
		expect(stripeCalls).toHaveLength(0);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("opens POST /pay's PaymentIntent on the landlord's account and tells the client which account", async () => {
		const { service } = setup({ providerRef: null });
		const result = await service.pay(id.toString(), { _id: tenant } as any);
		const create = stripeCalls.find(call => call.url.endsWith("/payment_intents"))!;
		expect(create.account).toBe("acct_123");
		expect(create.body.get("amount")).toBe("69500");
		expect(create.body.get("application_fee_amount")).toBe("695");
		expect(create.body.get("transfer_data[destination]")).toBeNull();
		expect(result).toMatchObject({ clientSecret: "pi_secret", stripeAccountId: "acct_123" });
		expect(doc).toMatchObject({ stripeAccountId: "acct_123", providerRef: "pi_autopay", payoutStatus: null });
	});

	it("cancels a legacy open PaymentIntent on Seek's account instead of reusing it", async () => {
		const { service } = setup({ providerRef: "pi_legacy", provider: PaymentProvider.STRIPE, status: PaymentStatus.PENDING });
		const answering = global.fetch;
		global.fetch = jest.fn(async (url: string, init?: RequestInit) =>
			url.endsWith("/payment_intents/pi_legacy")
				? ({ ok: true, status: 200, json: async () => ({ id: "pi_legacy", status: "requires_payment_method", client_secret: "old" }) } as Response)
				: (answering as any)(url, init)) as never;
		const result = await service.pay(id.toString(), { _id: tenant } as any);
		expect(stripeCalls.find(call => call.url.endsWith("/pi_legacy/cancel"))!.account).toBeUndefined();
		expect(result).toMatchObject({ clientSecret: "pi_secret", stripeAccountId: "acct_123" });
	});
});

describe("PaymentsService.landlordMonth", () => {
	it("shows the landlord which paid holding deposits must be refunded", async () => {
		const landlord = new Types.ObjectId();
		const query = (value: unknown) => {
			const chain: Record<string, unknown> = { exec: () => Promise.resolve(value) };
			for (const method of ["populate", "sort", "lean", "select", "limit"]) chain[method] = () => chain;
			return chain;
		};
		const deposit = {
			_id: new Types.ObjectId(),
			kind: PaymentKind.HOLDING_DEPOSIT,
			tenancy: null,
			application: { listing: { propertyTitle: "Cotham Flat" } },
			tenant: { _id: new Types.ObjectId(), name: "Maya" },
			landlord,
			amount: 15000,
			seekFee: 0,
			payout: 15000,
			status: PaymentStatus.PAID,
			dueDate: new Date(),
			paidAt: new Date(),
			refundDue: true
		};
		const paymentModel = { find: jest.fn().mockReturnValueOnce(query([deposit])).mockReturnValue(query([])) };
		const service = new PaymentsService(
			paymentModel as any,
			{ find: jest.fn().mockReturnValue(lean([])) } as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{ get: () => undefined } as any,
			{} as any
		);

		const month = await service.landlordMonth(landlord.toString());

		expect(month.rows[0]).toMatchObject({ kind: PaymentKind.HOLDING_DEPOSIT, property: "Cotham Flat", refundDue: true });
		expect(month.holdingDepositsCollected).toBe(15000);
	});
});

describe("PaymentsService.connectOnboard (Stripe Accounts v2)", () => {
	const landlord = new Types.ObjectId();
	const realFetch = global.fetch;
	afterAll(() => {
		global.fetch = realFetch;
	});

	function setup(respond: (url: string) => { ok: boolean; status: number; body: unknown }) {
		const calls: { url: string; init: RequestInit }[] = [];
		global.fetch = jest.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			const { ok, status, body } = respond(url);
			return { ok, status, json: async () => body } as Response;
		}) as never;
		const userModel = {
			findById: jest.fn().mockReturnValue(lean({ email: "landlord@example.com" })),
			updateOne: jest.fn().mockReturnValue({ exec: () => Promise.resolve({}) })
		};
		const config = { get: (key: string) => (key === "STRIPE_SECRET_KEY" ? "sk_test_x" : undefined) };
		const service = new PaymentsService(
			{} as any, {} as any, {} as any, {} as any, userModel as any, {} as any, {} as any, {} as any, config as any, {} as any
		);
		return { service, calls, userModel };
	}

	it("creates a v2 recipient account (JSON, v2 version, idempotent) and returns its onboarding link", async () => {
		const { service, calls, userModel } = setup((url) => ({
			ok: true,
			status: 200,
			body: url.endsWith("/v2/core/accounts") ? { id: "acct_v2" } : { url: "https://connect.stripe.com/setup/e/acct_v2/x" }
		}));

		const result = await service.connectOnboard({ _id: landlord } as any);

		expect(result).toEqual({ mode: "stripe", accountId: "acct_v2", url: "https://connect.stripe.com/setup/e/acct_v2/x" });
		const [create, link] = calls;
		expect(create.url).toBe("https://api.stripe.com/v2/core/accounts");
		const headers = create.init.headers as Record<string, string>;
		expect(headers["Stripe-Version"]).toMatch(/^20\d\d-\d\d-\d\d\.\w+$/);
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["Idempotency-Key"]).toBe(`seek-connect-${landlord.toString()}`);
		expect(JSON.parse(String(create.init.body))).toMatchObject({
			contact_email: "landlord@example.com",
			dashboard: "express",
			identity: { country: "gb" },
			configuration: {
				merchant: { capabilities: { card_payments: { requested: true } } },
				recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } }
			}
		});
		expect(link.url).toBe("https://api.stripe.com/v2/core/account_links");
		const linkBody = JSON.parse(String(link.init.body));
		expect(linkBody).toMatchObject({ account: "acct_v2", use_case: { type: "account_onboarding" } });
		expect(linkBody.use_case.account_onboarding).not.toHaveProperty("configurations");
		expect(userModel.updateOne).toHaveBeenCalledWith({ _id: landlord }, { $set: { stripeAccountId: "acct_v2" } });
	});

	it("asks an existing account for card payments before sending the landlord back to onboarding", async () => {
		const { service, calls, userModel } = setup(() => ({ ok: true, status: 200, body: { id: "acct_old", url: "https://connect.stripe.com/setup/e/acct_old/x" } }));
		userModel.findById.mockReturnValue(lean({ email: "landlord@example.com", stripeAccountId: "acct_old" }));

		await service.connectOnboard({ _id: landlord } as any);

		expect(calls.map(call => call.url)).toEqual(["https://api.stripe.com/v2/core/accounts/acct_old", "https://api.stripe.com/v2/core/account_links"]);
		expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ configuration: { merchant: { capabilities: { card_payments: { requested: true } } } } });
	});

	it("reports charges enabled only once the landlord can take card payments", async () => {
		const status = async (capabilities: Record<string, string>) => {
			const { service, userModel } = setup(() => ({ ok: true, status: 200, body: { id: "acct_1", capabilities } }));
			userModel.findById.mockReturnValue(lean({ stripeAccountId: "acct_1" }));
			return (await service.connectStatus(landlord.toString())).chargesEnabled;
		};
		expect(await status({ card_payments: "active" })).toBe(true);
		expect(await status({ card_payments: "pending" })).toBe(false);
	});

	it("says Connect is off only when Stripe says so; any other Stripe error is a 502", async () => {
		const fail = (code: string, message: string) => setup(() => ({ ok: false, status: 400, body: { error: { code, message } } }));

		await expect(fail("platform_registration_required", "Sign up for Connect").service.connectOnboard({ _id: landlord } as any))
			.rejects.toMatchObject({ status: 409 });
		await expect(fail("account_creation_losses_collector_unavailable", "Platform as losses collector").service.connectOnboard({ _id: landlord } as any))
			.rejects.toMatchObject({ status: 409 });
		await expect(fail("invalid_request", "Stripe no longer recommends Accounts v1 for new Connect integrations").service.connectOnboard({ _id: landlord } as any))
			.rejects.toMatchObject({ status: 502 });
	});
});

describe("StripeClient.retrieveAccount", () => {
	it("still reads accounts through the v1 endpoint (works for v1 and v2 ids)", async () => {
		const realFetch = global.fetch;
		const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "acct_old" }) }) as Response);
		global.fetch = fetchMock as never;
		const { StripeClient } = await import("./stripe");
		await new StripeClient("sk_test_x").retrieveAccount("acct_old");
		expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("https://api.stripe.com/v1/accounts/acct_old");
		global.fetch = realFetch;
	});
});

describe("PaymentsService.getPlan", () => {
	it("says whether a card is saved for autopay without exposing it", async () => {
		const tenancy = { _id: new Types.ObjectId(), listing: new Types.ObjectId(), monthlyRent: 69500, bankTransferInstructions: "Use surname as reference" };
		const plan = { _id: new Types.ObjectId(), autopay: true };
		const planModel = { findOne: jest.fn().mockReturnValue(lean(plan)), exists: jest.fn().mockResolvedValue({ _id: plan._id }) };
		const paymentModel = { find: () => ({ sort: () => ({ limit: () => lean([]) }) }) };
		const service = new PaymentsService(
			paymentModel as any, planModel as any, {} as any,
			{ findById: () => lean({ nation: "ENGLAND" }) } as any,
			{} as any, { findForTenant: jest.fn().mockResolvedValue(tenancy) } as any,
			{} as any, {} as any, { get: () => undefined } as any, {} as any
		);
		const viewer = { _id: new Types.ObjectId() } as any;

		const view = await service.getPlan("t", viewer);
		expect(view.autopayCardSaved).toBe(true);
		expect(view.bankTransferInstructions).toBe("Use surname as reference");
		expect(planModel.exists).toHaveBeenCalledWith({ _id: plan._id, paymentMethodId: { $nin: [null, ""] } });
		expect(view.plan).not.toHaveProperty("paymentMethodId");

		planModel.exists.mockResolvedValue(null);
		expect((await service.getPlan("t", viewer)).autopayCardSaved).toBe(false);
	});
});

describe("PaymentsService.updatePlan", () => {
	it("skips the listing's plan check when the frequency is unchanged, and applies it when it changes", async () => {
		const tenancy = { _id: new Types.ObjectId(), status: "ACTIVE", listing: new Types.ObjectId() };
		const listingModel = { findById: jest.fn().mockReturnValue(lean({ nation: "ENGLAND", paymentPlans: ["MONTHLY"] })) };
		const planModel = { findOne: jest.fn().mockReturnValue(lean({ frequency: "SIX_MONTHS" })), updateOne: jest.fn(), exists: jest.fn() };
		const service = new PaymentsService(
			{ exists: jest.fn().mockResolvedValue(true) } as any,
			planModel as any,
			{} as any,
			listingModel as any,
			{} as any,
			{ findForTenant: jest.fn().mockResolvedValue(tenancy) } as any,
			{} as any,
			{} as any,
			{ get: () => undefined } as any,
			{} as any
		);
		jest.spyOn(service, "getPlan").mockResolvedValue({} as any);
		const tenant = { _id: new Types.ObjectId() } as any;
		await expect(service.updatePlan("t", { frequency: "SIX_MONTHS" } as any, tenant)).resolves.toBeDefined();
		await expect(service.updatePlan("t", { frequency: "YEARLY" } as any, tenant)).rejects.toBeInstanceOf(BadRequestException);
	});
});

describe("PaymentsService.mode", () => {
	const build = (env: Record<string, string | undefined>) =>
		new PaymentsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { get: (key: string) => env[key] } as any, {} as any);

	it("simulates payments only under NODE_ENV development or test, never when NODE_ENV is unset or unknown", () => {
		expect(build({ NODE_ENV: "development" }).mode()).toBe("simulated");
		expect(build({ NODE_ENV: "test" }).mode()).toBe("simulated");
		expect(build({}).mode()).toBe("unavailable");
		expect(build({ NODE_ENV: "prod" }).mode()).toBe("unavailable");
		expect(build({ NODE_ENV: "production" }).mode()).toBe("unavailable");
		expect(build({ NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_x" }).mode()).toBe("stripe");
	});
});

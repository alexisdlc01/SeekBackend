import { createHmac } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";
import { PaymentsService } from "./payments.service";
import { PaymentKind, PaymentStatus, PayoutStatus } from "./payment.enums";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

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
		seekFee: 348,
		payout: 69152,
		status: PaymentStatus.SCHEDULED,
		dueDate: new Date("2026-12-01T00:00:00Z"),
		providerRef: null
	};
	const calls: { url: string; body: URLSearchParams; key?: string }[] = [];
	const openOffer = { stage: "OFFERED", offerExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000) };
	let offer: Record<string, unknown> = openOffer;
	let lastPaymentModel: { updateOne: jest.Mock; find?: jest.Mock };
	const realFetch = global.fetch;

	function setup(account: { charges_enabled: boolean } | null, autopay: boolean, stored: Record<string, unknown> = payment) {
		calls.length = 0;
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
			calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")), key });
			const body = url.includes("/accounts/")
				? account ?? { error: { message: "No such account" } }
				: url.includes("/customers")
					? { id: "cus_1" }
					: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" };
			return { ok: !(url.includes("/accounts/") && !account), status: 200, json: async () => body } as Response;
		}) as never;
		const paymentModel = {
			findById: jest.fn().mockReturnValue(lean(stored)),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
		};
		const planModel = { findOne: jest.fn().mockReturnValue(lean({ autopay })) };
		const userModel = {
			findById: jest.fn((id: Types.ObjectId) =>
				lean(id.equals(landlord) ? { stripeAccountId: "acct_123" } : { email: "maya@example.com", name: "Maya" })
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
			{} as any,
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
		await expect(setup({ charges_enabled: true }, false, holding).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile"))
			.rejects.toThrow("no longer open");
		expect(calls).toHaveLength(0);
		offer = { stage: "VIEWED", offerExpiresAt: null };
		await expect(setup({ charges_enabled: true }, false, holding).pay(payment._id.toString(), { _id: tenant } as any)).rejects.toThrow("no longer open");

		const ends = new Date(Date.now() + 2 * 3_600_000);
		offer = { stage: "OFFERED", offerExpiresAt: ends };
		await setup({ charges_enabled: true }, false, holding).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
		const session = calls.find(call => call.url.endsWith("/checkout/sessions"))!.body;
		expect(Number(session.get("expires_at"))).toBe(Math.floor(ends.getTime() / 60_000) * 60);
		offer = openOffer;
	});

	it("only sends the payer back to Seek: web app, app scheme, and Expo Go or localhost outside production", async () => {
		const service = setup({ charges_enabled: true }, false);
		const pay = (successUrl: string) => service.checkout(payment._id.toString(), { _id: tenant } as any, { successUrl }, "mobile");
		await expect(pay("https://evil.example/phish")).rejects.toThrow("Return URLs must point back to Seek");
		await expect(pay("exp://192.168.1.20:8081/--/pay?checkout=success")).resolves.toMatchObject({ mode: "stripe" });
		await expect(pay("http://localhost:5173/student/home/rent")).resolves.toMatchObject({ mode: "stripe" });
		await expect(pay("seekapp://pay")).resolves.toMatchObject({ mode: "stripe" });
	});

	it("sends the fee and destination to a ready landlord and saves the card for autopay", async () => {
		const service = setup({ charges_enabled: true }, true);
		const result = await service.checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");

		expect(result).toMatchObject({ mode: "stripe", sessionId: "cs_test_1" });
		const session = calls.find(call => call.url.endsWith("/checkout/sessions"))!.body;
		expect(session.get("mode")).toBe("payment");
		expect(session.get("line_items[0][price_data][unit_amount]")).toBe("69500");
		expect(session.get("payment_intent_data[application_fee_amount]")).toBe("348");
		expect(session.get("payment_intent_data[transfer_data][destination]")).toBe("acct_123");
		expect(session.get("payment_intent_data[setup_future_usage]")).toBe("off_session");
		expect(session.get("metadata[paymentId]")).toBe(payment._id.toString());
		expect(session.get("success_url")).toMatch(/^seekapp:\/\/rent-plan\?checkout=success/);
	});

	it("charges without a destination when the landlord has no usable account", async () => {
		const service = setup(null, false);
		await service.checkout(payment._id.toString(), { _id: tenant } as any, {}, undefined);

		const session = calls.find(call => call.url.endsWith("/checkout/sessions"))!.body;
		expect(session.get("payment_intent_data[transfer_data][destination]")).toBeNull();
		expect(session.get("payment_intent_data[application_fee_amount]")).toBeNull();
		expect(session.get("payment_intent_data[setup_future_usage]")).toBeNull();
		expect(session.get("success_url")).toMatch(/^http:\/\/localhost:5173\/student\/home\/rent\?/);
		// Seek holds the money: the payment says so until a transfer releases it.
		expect(lastPaymentModel.updateOne).toHaveBeenCalledWith(
			expect.anything(),
			{ $set: expect.objectContaining({ providerRef: "cs_test_1", payoutStatus: PayoutStatus.HELD }) }
		);
	});

	it("releases held payments to a ready account, minus Seek's 0.5% fee, tied to the original charge", async () => {
		const service = setup({ charges_enabled: true }, false);
		const held = { ...payment, status: PaymentStatus.PAID, payoutStatus: PayoutStatus.HELD, providerRef: "pi_1" };
		lastPaymentModel.find = jest.fn().mockReturnValue(lean([held]));
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
			const body = url.includes("/accounts/") ? { charges_enabled: true } : url.includes("/payment_intents/") ? { id: "pi_1", latest_charge: "ch_1" } : { id: "tr_1" };
			return { ok: true, status: 200, json: async () => body } as Response;
		}) as never;
		calls.length = 0;
		expect(await service.releaseHeldPayouts()).toBe(1);
		const transfer = calls.find(call => call.url.endsWith("/transfers"))!.body;
		expect(transfer.get("amount")).toBe(String(69500 - Math.round(69500 * 0.005)));
		expect(transfer.get("destination")).toBe("acct_123");
		expect(transfer.get("source_transaction")).toBe("ch_1");
		expect(lastPaymentModel.updateOne).toHaveBeenCalledWith(
			{ _id: payment._id, payoutStatus: PayoutStatus.HELD },
			{ $set: { payoutStatus: PayoutStatus.TRANSFERRED, transferRef: "tr_1" } }
		);
	});

	it("keys the session on the whole request, so a changed autopay choice opens a new session", async () => {
		const sessionKey = async (autopay: boolean) => {
			await setup({ charges_enabled: true }, autopay).checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
			return calls.find(call => call.url.endsWith("/checkout/sessions"))!.key;
		};
		const withAutopay = await sessionKey(true);
		expect(withAutopay).toMatch(/^seek-checkout-/);
		expect(await sessionKey(true)).toBe(withAutopay);
		expect(await sessionKey(false)).not.toBe(withAutopay);
	});

	it("sends no Seek fee on a holding deposit", async () => {
		const holding = { ...payment, kind: PaymentKind.HOLDING_DEPOSIT, tenancy: undefined, application: new Types.ObjectId(), seekFee: 0, payout: 69500 };
		const service = setup({ charges_enabled: true }, false, holding);
		jest.spyOn(service as any, "describe").mockResolvedValue("Holding deposit");
		await service.checkout(payment._id.toString(), { _id: tenant } as any, {}, "mobile");
		const session = calls.find(call => call.url.endsWith("/checkout/sessions"))!.body;
		expect(session.get("payment_intent_data[transfer_data][destination]")).toBe("acct_123");
		expect(session.get("payment_intent_data[application_fee_amount]")).toBeNull();
	});
});

describe("PaymentsService confirm, webhook and duplicate charges (Stripe)", () => {
	const secret = "whsec_test";
	const tenant = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const tenancy = new Types.ObjectId();
	const id = new Types.ObjectId();
	const realFetch = global.fetch;
	let doc: Record<string, any>;
	let stripeCalls: { method: string; url: string; body: URLSearchParams }[];
	let session: Record<string, any>;
	let failExpire: boolean;

	function setup(stored: Record<string, unknown> = {}) {
		doc = { _id: id, kind: PaymentKind.RENT, tenancy, tenant, landlord, amount: 69500, seekFee: 348, payout: 69152, status: PaymentStatus.SCHEDULED, dueDate: new Date("2026-12-01T00:00:00Z"), providerRef: "cs_1", ...stored };
		session = { id: "cs_1", status: "complete", payment_status: "paid", amount_total: 69500, customer: "cus_1", metadata: { paymentId: id.toString() }, payment_intent: { id: "pi_checkout", payment_method: "pm_card" } };
		stripeCalls = [];
		failExpire = false;
		global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
			stripeCalls.push({ method: init?.method ?? "GET", url, body: new URLSearchParams(String(init?.body ?? "")) });
			if (url.includes("/expire") && failExpire) return { ok: false, status: 400, json: async () => ({ error: { message: "nope" } }) } as Response;
			const body = url.includes("/checkout/sessions/") ? session
				: url.includes("/payment_intents/") ? { id: url.split("/payment_intents/")[1], transfer_data: { destination: "acct_123" }, application_fee_amount: 348 }
				: url.endsWith("/payment_intents") ? { id: "pi_autopay", status: "succeeded" }
				: url.includes("/accounts/") ? { charges_enabled: true }
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
			find: jest.fn(() => lean([{ tenancy, tenant, paymentMethodId: "pm_card" }])),
			findOne: jest.fn(() => lean({ notifyEveryPayment: true })),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const userModel = {
			findById: jest.fn(() => lean({ name: "Maya", stripeCustomerId: "cus_1", stripeAccountId: "acct_123" })),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const tenancyModel = { findById: jest.fn().mockReturnValue({ populate: () => lean({ listing: { propertyTitle: "Cotham Flat" } }) }) };
		const notifications = { notify: jest.fn().mockResolvedValue(true) };
		const config = { get: (key: string) => ({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: secret } as Record<string, string>)[key] };
		const service = new PaymentsService(paymentModel as any, planModel as any, tenancyModel as any, {} as any, userModel as any, {} as any, {} as any, notifications as any, config as any, {} as any);
		const webhook = (event: unknown, key = secret) => {
			const body = JSON.stringify(event);
			const t = Math.floor(Date.now() / 1000);
			return service.handleWebhook(Buffer.from(body), `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`);
		};
		const refunds = () => stripeCalls.filter(call => call.url.endsWith("/refunds"));
		return { service, webhook, refunds, notifications, planModel, paymentModel };
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

	it("leaves the payment unpaid when Stripe's amount differs", async () => {
		const { service } = setup();
		session.amount_total = 100;
		await service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("marks paid once and sends one receipt when confirm and the webhook both arrive", async () => {
		const { service, webhook, refunds, notifications } = setup();
		await service.confirmCheckout(id.toString(), "cs_1", { _id: tenant } as any);
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_checkout" } } });
		expect(doc).toMatchObject({ status: PaymentStatus.PAID, providerRef: "pi_checkout" });
		expect(notifications.notify.mock.calls.filter(([n]) => n.kind === "RENT_RECEIPT")).toHaveLength(1);
		expect(refunds()).toHaveLength(0);
	});

	it("rejects a webhook with a bad signature", async () => {
		const { webhook } = setup();
		await expect(webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } }, "whsec_other")).rejects.toThrow(BadRequestException);
		expect(doc.status).toBe(PaymentStatus.SCHEDULED);
	});

	it("saves the autopay card when only the webhook confirms (its payment_intent is a bare id)", async () => {
		const { webhook, planModel } = setup();
		await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_checkout", metadata: { paymentId: id.toString() }, payment_status: "paid" } } });
		expect(planModel.updateOne).toHaveBeenCalledWith(expect.objectContaining({ autopay: true }), { $set: { paymentMethodId: "pm_card" } });
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

	it("returns no url for a payment already paid", async () => {
		const { service } = setup({ status: PaymentStatus.PAID });
		await expect(service.checkout(id.toString(), { _id: tenant } as any, {}, "web")).resolves.toMatchObject({ url: null, status: PaymentStatus.PAID });
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

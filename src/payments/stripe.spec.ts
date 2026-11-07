import { createHmac } from "crypto";
import { toStripeForm, verifyStripeSignature } from "./stripe";

describe("Stripe helpers", () => {
	const secret = "whsec_test_secret";
	const payload = JSON.stringify({ type: "payment_intent.succeeded" });
	const sign = (timestamp: number, body = payload, key = secret) =>
		createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

	it("accepts a valid signature within the tolerance", () => {
		const t = 1_800_000_000;
		const header = `t=${t},v1=${sign(t)}`;
		expect(verifyStripeSignature({ payload, header, secret, nowSeconds: t + 10 })).toBe(true);
		expect(verifyStripeSignature({ payload: Buffer.from(payload), header, secret, nowSeconds: t })).toBe(true);
	});

	it("rejects tampered, stale, missing or wrongly keyed signatures", () => {
		const t = 1_800_000_000;
		expect(verifyStripeSignature({ payload: payload + " ", header: `t=${t},v1=${sign(t)}`, secret, nowSeconds: t })).toBe(false);
		expect(verifyStripeSignature({ payload, header: `t=${t},v1=${sign(t)}`, secret, nowSeconds: t + 301 })).toBe(false);
		expect(verifyStripeSignature({ payload, header: undefined, secret, nowSeconds: t })).toBe(false);
		expect(verifyStripeSignature({ payload, header: `t=${t},v1=${sign(t, payload, "other")}`, secret, nowSeconds: t })).toBe(false);
		expect(verifyStripeSignature({ payload, header: "garbage", secret, nowSeconds: t })).toBe(false);
	});

	it("flattens nested params the way the Stripe API expects", () => {
		const form = toStripeForm({
			amount: 69500,
			automatic_payment_methods: { enabled: true },
			transfer_data: { destination: "acct_123" },
			metadata: { paymentId: "abc" }
		});
		expect(form.get("amount")).toBe("69500");
		expect(form.get("automatic_payment_methods[enabled]")).toBe("true");
		expect(form.get("transfer_data[destination]")).toBe("acct_123");
		expect(form.get("metadata[paymentId]")).toBe("abc");
	});
});

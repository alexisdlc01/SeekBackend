import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's default tolerance for webhook timestamps. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header (t=...,v1=...) against the raw body,
 * as Stripe's SDK does: HMAC-SHA256 of `${t}.${body}` with the endpoint secret,
 * compared in constant time, rejecting stale timestamps.
 */
export function verifyStripeSignature(params: {
	payload: Buffer | string;
	header: string | undefined;
	secret: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}): boolean {
	if (!params.header || !params.secret) return false;
	let timestamp: number | null = null;
	const signatures: string[] = [];
	for (const part of params.header.split(",")) {
		const [key, value] = part.split("=", 2).map(piece => piece?.trim());
		if (key === "t" && value) timestamp = Number(value);
		if (key === "v1" && value) signatures.push(value);
	}
	if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) {
		return false;
	}

	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
	const tolerance = params.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
	if (Math.abs(now - timestamp) > tolerance) return false;

	const payload = typeof params.payload === "string"
		? params.payload
		: params.payload.toString("utf8");
	const expected = Buffer.from(
		createHmac("sha256", params.secret).update(`${timestamp}.${payload}`).digest("hex"),
		"utf8"
	);
	return signatures.some(signature => {
		const candidate = Buffer.from(signature, "utf8");
		return candidate.length === expected.length && timingSafeEqual(candidate, expected);
	});
}

/** Flattens nested params into Stripe's form encoding (a[b]=c). */
export function toStripeForm(params: Record<string, unknown>, prefix = ""): URLSearchParams {
	const form = new URLSearchParams();
	const append = (value: unknown, key: string) => {
		if (value === undefined || value === null) return;
		if (typeof value === "object" && !Array.isArray(value)) {
			for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
				append(childValue, `${key}[${child}]`);
			}
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => append(item, `${key}[${index}]`));
			return;
		}
		form.append(key, String(value));
	};
	for (const [key, value] of Object.entries(params)) {
		append(value, prefix ? `${prefix}[${key}]` : key);
	}
	return form;
}

export interface StripePaymentIntent {
	id: string;
	client_secret: string | null;
	status: string;
	amount: number;
	metadata?: Record<string, string>;
	/** The charge behind a succeeded intent: the source of a later transfer. */
	latest_charge?: string | null;
	/** Set on destination charges: a refund must pull the money back from the landlord. */
	transfer_data?: { destination: string } | null;
	application_fee_amount?: number | null;
}

export interface StripeAccount {
	id: string;
	charges_enabled: boolean;
	payouts_enabled: boolean;
	details_submitted: boolean;
	/** `transfers: "active"` = the account can be a destination charge / transfer target. */
	capabilities?: { transfers?: string };
	external_accounts?: { data?: StripeExternalAccount[] };
}

export interface StripeCheckoutSession {
	id: string;
	url: string | null;
	status: string;
	payment_status: string;
	amount_total: number | null;
	customer: string | null;
	metadata?: Record<string, string>;
	success_url?: string | null;
	cancel_url?: string | null;
	/** Expanded on retrieve: the PaymentIntent and its saved payment method. */
	payment_intent?: string | (StripePaymentIntent & { payment_method?: string | null }) | null;
}

export interface StripeExternalAccount {
	last4?: string;
	bank_name?: string | null;
	status?: string;
}

export interface StripeAccountLink {
	url: string;
	expires_at: string;
}

export class StripeApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) {
		super(message);
	}
}

/** Stripe API version for /v2 endpoints (Accounts v2). */
export const STRIPE_V2_VERSION = "2026-10-28.endive";

/** Minimal Stripe REST client over fetch (no SDK dependency). */
export class StripeClient {
	private readonly baseUrl = "https://api.stripe.com/v1";

	constructor(private readonly secretKey: string) {}

	createPaymentIntent(
		params: Record<string, unknown>,
		idempotencyKey: string
	): Promise<StripePaymentIntent> {
		return this.request("POST", "/payment_intents", params, idempotencyKey);
	}

	retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
		return this.request("GET", `/payment_intents/${encodeURIComponent(id)}`);
	}

	/**
	 * A GB connected account (Accounts v2, Express dashboard) that receives a
	 * landlord's rent as the recipient of destination charges and transfers.
	 */
	createRecipientAccount(
		params: { contact_email?: string; metadata?: Record<string, string> },
		idempotencyKey: string
	): Promise<{ id: string }> {
		return this.request(
			"POST",
			"/v2/core/accounts",
			{
				...params,
				dashboard: "express",
				identity: { country: "gb" },
				configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
				// Stripe only allows these values for recipient-only accounts; the platform must have
				// acknowledged loss liability (Dashboard > Connect > Platform profile) or creation fails.
				defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } }
			},
			idempotencyKey
		);
	}

	/** v1 view of any account: Stripe serves v2 accounts on this endpoint too. */
	retrieveAccount(id: string): Promise<StripeAccount> {
		return this.request("GET", `/accounts/${encodeURIComponent(id)}`);
	}

	/** The hosted onboarding page for an account (links are single use). */
	createAccountLink(params: { account: string; return_url: string; refresh_url: string }): Promise<StripeAccountLink> {
		const { account, ...urls } = params;
		return this.request("POST", "/v2/core/account_links", {
			account,
			use_case: { type: "account_onboarding", account_onboarding: { configurations: ["recipient"], ...urls } }
		});
	}

	/** A hosted Checkout page (mode=payment). */
	createCheckoutSession(params: Record<string, unknown>, idempotencyKey: string): Promise<StripeCheckoutSession> {
		return this.request("POST", "/checkout/sessions", params, idempotencyKey);
	}

	retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession> {
		return this.request(
			"GET",
			`/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent`
		);
	}

	/** Closes an open session so it can no longer be paid. */
	expireCheckoutSession(id: string): Promise<StripeCheckoutSession> {
		return this.request("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
	}

	/** Moves money Seek collected to a connected account. */
	createTransfer(params: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string }> {
		return this.request("POST", "/transfers", params, idempotencyKey);
	}

	/** Refunds a whole PaymentIntent. */
	createRefund(params: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string; status: string }> {
		return this.request("POST", "/refunds", params, idempotencyKey);
	}

	createCustomer(params: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string }> {
		return this.request("POST", "/customers", params, idempotencyKey);
	}

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		params?: Record<string, unknown>,
		idempotencyKey?: string
	): Promise<T> {
		// v2 endpoints take JSON and need a v2 API version; v1 stays form-encoded on its pinned version.
		const v2 = path.startsWith("/v2/");
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.secretKey}`,
			"Stripe-Version": v2 ? STRIPE_V2_VERSION : "2024-06-20"
		};
		if (method === "POST") headers["Content-Type"] = v2 ? "application/json" : "application/x-www-form-urlencoded";
		if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

		let body: string | undefined;
		if (method === "POST" && params) body = v2 ? JSON.stringify(params) : toStripeForm(params).toString();
		const response = await fetch(v2 ? `https://api.stripe.com${path}` : `${this.baseUrl}${path}`, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(15_000)
		});
		const json = (await response.json().catch(() => ({}))) as {
			error?: { message?: string; code?: string };
		};
		if (!response.ok) {
			throw new StripeApiError(json.error?.message ?? "Stripe request failed", response.status, json.error?.code);
		}
		return json as T;
	}
}

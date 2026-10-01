import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets that reach a user — email confirmation links, password resets,
 * invites — are stored only as a digest, so a database read does not hand
 * somebody a working token.
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function generateToken(bytes = 32): string {
	return randomBytes(bytes).toString("hex");
}

/** Constant-time comparison of a raw token against a stored digest. */
export function tokensMatch(rawToken: string, expectedHash: string): boolean {
	if (typeof rawToken !== "string" || typeof expectedHash !== "string") {
		return false;
	}

	const actual = Buffer.from(hashToken(rawToken), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

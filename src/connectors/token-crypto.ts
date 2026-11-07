import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Reads CONNECTOR_ENCRYPTION_KEY: 32 bytes as 64 hex characters or base64.
 * Returns null when the value is missing or malformed.
 */
export function parseEncryptionKey(raw: string | undefined | null): Buffer | null {
	const value = raw?.trim();
	if (!value) return null;
	if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.length === 32 ? decoded : null;
	} catch {
		return null;
	}
}

/** Development-only key derived from another local secret, so tokens are never stored in clear. */
export function deriveDevelopmentKey(seed: string): Buffer {
	return createHash("sha256").update(`seek-connector-dev-key:${seed}`).digest();
}

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext>, all base64. */
export function encryptToken(plain: string, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(payload: string, key: Buffer): string {
	const [version, iv, tag, ciphertext] = payload.split(":");
	if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
		throw new Error("Unrecognised token format.");
	}
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
	decipher.setAuthTag(Buffer.from(tag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64")),
		decipher.final()
	]).toString("utf8");
}

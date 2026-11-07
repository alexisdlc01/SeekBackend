import { randomBytes } from "node:crypto";
import { decryptToken, deriveDevelopmentKey, encryptToken, parseEncryptionKey } from "./token-crypto";

describe("connector token encryption", () => {
	const key = randomBytes(32);

	it("round-trips a token without storing it in clear", () => {
		const sealed = encryptToken("ya29.secret-token", key);
		expect(sealed.startsWith("v1:")).toBe(true);
		expect(sealed).not.toContain("secret-token");
		expect(decryptToken(sealed, key)).toBe("ya29.secret-token");
	});

	it("uses a fresh IV every time", () => {
		expect(encryptToken("same", key)).not.toBe(encryptToken("same", key));
	});

	it("rejects tampered ciphertext and the wrong key", () => {
		const sealed = encryptToken("token", key);
		const parts = sealed.split(":");
		parts[3] = Buffer.from("tampered").toString("base64");
		expect(() => decryptToken(parts.join(":"), key)).toThrow();
		expect(() => decryptToken(sealed, randomBytes(32))).toThrow();
		expect(() => decryptToken("plain-token", key)).toThrow("Unrecognised token format.");
	});

	it("reads hex and base64 keys and refuses malformed ones", () => {
		expect(parseEncryptionKey(key.toString("hex"))?.equals(key)).toBe(true);
		expect(parseEncryptionKey(key.toString("base64"))?.equals(key)).toBe(true);
		expect(parseEncryptionKey("too-short")).toBeNull();
		expect(parseEncryptionKey("")).toBeNull();
		expect(parseEncryptionKey(undefined)).toBeNull();
	});

	it("derives a stable 32-byte development key", () => {
		expect(deriveDevelopmentKey("dev").length).toBe(32);
		expect(deriveDevelopmentKey("dev").equals(deriveDevelopmentKey("dev"))).toBe(true);
	});
});

import { buildPassport, effectiveStatus, withoutFiles } from "./passport";
import { DocumentStatus, DocumentType } from "./types/document-type";
import { isShareActive } from "./shares/document-shares.service";

const now = new Date("2026-11-06T12:00:00Z");
const verified = (type: DocumentType, extra = {}) => ({
	type,
	status: DocumentStatus.VERIFIED,
	url: `https://files.example/${type}`,
	key: `private/u/${type}.pdf`,
	...extra
});

describe("Seek Passport", () => {
	it("is ready once every required item is verified", () => {
		const passport = buildPassport([
			verified(DocumentType.PASSPORT),
			verified(DocumentType.RIGHT_TO_RENT),
			verified(DocumentType.STUDENT_STATUS),
			verified(DocumentType.PROOF_OF_FUNDS)
		], now);
		expect(passport.ready).toBe(true);
		expect(passport.total).toBe(10);
		expect(passport.completed).toBe(4);
		expect(passport.percent).toBe(40);
		expect(passport.missingRequired).toEqual([]);
	});

	it("accepts legacy document types and lists what is missing", () => {
		const passport = buildPassport([
			verified(DocumentType.IDENTIFICATION),
			verified(DocumentType.PROOF_OF_INCOME),
			{ type: DocumentType.RIGHT_TO_RENT, status: DocumentStatus.PENDING }
		], now);
		expect(passport.ready).toBe(false);
		expect(passport.missingRequired).toEqual([DocumentType.RIGHT_TO_RENT, DocumentType.STUDENT_STATUS]);
	});

	it("treats expired documents as expired whatever was stored", () => {
		expect(effectiveStatus(verified(DocumentType.PASSPORT, { expiresAt: "2026-11-01" }), now)).toBe(DocumentStatus.EXPIRED);
		expect(effectiveStatus({ type: DocumentType.VISA }, now)).toBe(DocumentStatus.PENDING);
	});

	it("drops file locations for viewers without a share", () => {
		const passport = withoutFiles(buildPassport([verified(DocumentType.PASSPORT)], now));
		const item = passport.sections[0].items[0];
		expect(item.status).toBe(DocumentStatus.VERIFIED);
		expect(item.url).toBeUndefined();
		expect(item.key).toBeUndefined();
	});
});

describe("document shares", () => {
	it("are active until they expire or are revoked", () => {
		expect(isShareActive({ expiresAt: new Date("2026-11-20"), revokedAt: null }, now)).toBe(true);
		expect(isShareActive({ expiresAt: new Date("2026-11-01"), revokedAt: null }, now)).toBe(false);
		expect(isShareActive({ expiresAt: new Date("2026-11-20"), revokedAt: new Date("2026-11-05") }, now)).toBe(false);
	});
});

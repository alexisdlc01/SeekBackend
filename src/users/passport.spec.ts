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

	it("counts PROVIDED identity documents and shows the student why a document was rejected", () => {
		const provided = (type: DocumentType) => verified(type, { status: DocumentStatus.PROVIDED });
		const passport = buildPassport([
			provided(DocumentType.PASSPORT),
			provided(DocumentType.RIGHT_TO_RENT),
			verified(DocumentType.STUDENT_STATUS),
			verified(DocumentType.PROOF_OF_FUNDS),
			verified(DocumentType.CAS_LETTER, { status: DocumentStatus.REJECTED, rejectionReason: "Upload a current one." })
		], now);
		expect(passport.ready).toBe(true);
		expect(passport.completed).toBe(4);
		const items = (p: typeof passport) => p.sections.flatMap(section => section.items);
		expect(items(passport).find(item => item.type === DocumentType.PASSPORT)?.status).toBe(DocumentStatus.PROVIDED);
		expect(items(passport).find(item => item.type === DocumentType.CAS_LETTER)?.reason).toBe("Upload a current one.");
		expect(items(withoutFiles(passport)).find(item => item.type === DocumentType.CAS_LETTER)?.reason).toBeUndefined();
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

	it("counts a confirmed university email as verified student status", () => {
		const passport = buildPassport([
			verified(DocumentType.PASSPORT),
			verified(DocumentType.RIGHT_TO_RENT),
			verified(DocumentType.PROOF_OF_FUNDS)
		], now, { studentVerifiedAt: now, universityEmail: "ab12@st-andrews.ac.uk" });
		const item = passport.sections.flatMap(section => section.items).find(entry => entry.type === DocumentType.STUDENT_STATUS);
		expect(item).toMatchObject({ status: DocumentStatus.VERIFIED, source: "university email", detail: "ab12@st-andrews.ac.uk" });
		expect(passport.ready).toBe(true);
		expect(withoutFiles(passport).sections[1].items[0].detail).toBeUndefined();
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

describe("guarantor and reference requests", () => {
	const item = (passport: ReturnType<typeof buildPassport>, type: DocumentType) =>
		passport.sections.flatMap(section => section.items).find(entry => entry.type === type)!;
	const requested = { referenceRequests: [
		{ type: DocumentType.GUARANTOR_AGREEMENT, name: "Aisha Rahman", requestedAt: "2026-11-04T09:00:00Z" },
		{ type: DocumentType.AGENT_REFERENCE, name: "Bristol Lets", requestedAt: "2026-11-05T09:00:00Z" }
	] };

	it("shows a pending row with who was asked until a document arrives", () => {
		const passport = buildPassport([verified(DocumentType.AGENT_REFERENCE)], now, requested);
		expect(item(passport, DocumentType.GUARANTOR_AGREEMENT)).toMatchObject({
			status: DocumentStatus.PENDING, source: "request", detail: "Aisha Rahman", requestedAt: new Date("2026-11-04T09:00:00Z")
		});
		expect(item(passport, DocumentType.AGENT_REFERENCE)).toMatchObject({ status: DocumentStatus.VERIFIED, source: "document" });
		expect(item(passport, DocumentType.LANDLORD_REFERENCE).status).toBe("MISSING");
		expect(passport.completed).toBe(1);
		expect(withoutFiles(passport).sections[2].items[0].detail).toBeUndefined();
	});
});

describe("document shares", () => {
	it("are active until they expire or are revoked", () => {
		expect(isShareActive({ expiresAt: new Date("2026-11-20"), revokedAt: null }, now)).toBe(true);
		expect(isShareActive({ expiresAt: new Date("2026-11-01"), revokedAt: null }, now)).toBe(false);
		expect(isShareActive({ expiresAt: new Date("2026-11-20"), revokedAt: new Date("2026-11-05") }, now)).toBe(false);
	});
});

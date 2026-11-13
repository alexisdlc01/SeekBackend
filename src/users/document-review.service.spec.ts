import { DocumentReviewService, MAX_REVIEW_ATTEMPTS, ReviewAnswer, decideReview, namesMatch, parseReview } from "./document-review.service";
import { DocumentStatus, DocumentType } from "./types/document-type";

const now = new Date("2026-11-12T12:00:00Z");
const ok: ReviewAnswer = { matchesType: true, readable: true, nameOnDocument: "Chloé Marie DUBOIS", expiryDate: null };

describe("namesMatch", () => {
	it("ignores case, accents, middle names and surname-first order", () => {
		expect(namesMatch("Chloe Dubois", "CHLOÉ MARIE DUBOIS")).toBe(true);
		expect(namesMatch("Chloé Marie Dubois", "Chloe Dubois")).toBe(true);
		expect(namesMatch("Chloe Dubois", "DUBOIS, Chloe")).toBe(true);
		expect(namesMatch("Chloe Dubois", "Marc Dubois")).toBe(false);
		expect(namesMatch("Chloe Dubois", null)).toBe(false);
	});

	it("compares names in any script, and the Latin transliteration the model adds", () => {
		expect(namesMatch("王小明", "王小明")).toBe(true);
		expect(namesMatch("Wang Xiaoming", "王小明 / WANG Xiaoming")).toBe(true);
		expect(namesMatch("Wang Xiaoming", "李华 / Li Hua")).toBe(false);
	});

	it("needs the full name when either side is a single word", () => {
		expect(namesMatch("Dubois", "Anne Dubois")).toBe(false);
		expect(namesMatch("Chloe Dubois", "DUBOIS")).toBe(false);
		expect(namesMatch("Dubois Dubois", "Anne Dubois")).toBe(false);
		expect(namesMatch("Dubois", "DUBOIS")).toBe(true);
	});

	it("accepts a lone first or last name only when allowed (reference letters)", () => {
		expect(namesMatch("Emma Watson", "Emma", true)).toBe(true);
		expect(namesMatch("Emma Watson", "WATSON", true)).toBe(true);
		expect(namesMatch("Emma Watson", "Anne", true)).toBe(false);
		expect(namesMatch("Emma Watson", "Emma")).toBe(false);
	});
});

describe("decideReview", () => {
	it("verifies a readable document of the right type in the student's name, keeping its expiry", () => {
		expect(decideReview({ ...ok, expiryDate: "2027-06-30" }, DocumentType.STUDENT_STATUS, "Chloe Dubois", now))
			.toEqual({ status: DocumentStatus.VERIFIED, expiresAt: new Date("2027-06-30T23:59:59Z") });
	});

	it("accepts a reference letter naming the tenant by first name, not a financial document", () => {
		const first = { ...ok, nameOnDocument: "Chloe" };
		expect(decideReview(first, DocumentType.LANDLORD_REFERENCE, "Chloe Dubois", now).status).toBe(DocumentStatus.VERIFIED);
		expect(decideReview(first, DocumentType.PROOF_OF_FUNDS, "Chloe Dubois", now).status).toBe(DocumentStatus.REJECTED);
	});

	it("rejects with a short reason the student can act on", () => {
		const reason = (answer: typeof ok) => {
			const outcome = decideReview(answer, DocumentType.PROOF_OF_FUNDS, "Chloe Dubois", now);
			return outcome.status === DocumentStatus.REJECTED ? outcome.reason : null;
		};
		expect(reason({ ...ok, readable: false })).toMatch(/couldn't read/);
		expect(reason({ ...ok, matchesType: false })).toMatch(/doesn't look like proof of funds/);
		expect(reason({ ...ok, expiryDate: "2026-01-31" })).toMatch(/expired on 2026-01-31/);
		expect(reason({ ...ok, nameOnDocument: "Someone Else" })).toMatch(/name on this document.*sponsor letter that names you/);
	});

	it("treats anything but the asked JSON shape as no answer", () => {
		expect(parseReview("not json")).toBeNull();
		expect(parseReview('{"matchesType":"yes","readable":true}')).toBeNull();
		expect(parseReview('```json\n{"matchesType":true,"readable":true,"nameOnDocument":"A B","expiryDate":null,"reason":"ok"}\n```'))
			.toEqual({ matchesType: true, readable: true, nameOnDocument: "A B", expiryDate: null });
	});
});

describe("DocumentReviewService.review", () => {
	const realFetch = global.fetch;
	afterEach(() => { global.fetch = realFetch; });

	function setup(doc: Record<string, unknown>, llmText: string | null, storage?: unknown) {
		const user = { _id: "u1", name: "Chloe Dubois", documents: [doc] };
		const userModel = {
			findById: jest.fn(() => ({ lean: () => ({ exec: async () => user }) })),
			updateOne: jest.fn().mockResolvedValue({})
		};
		const uploads = { getPresignedDownloadUrl: jest.fn().mockResolvedValue("https://s3/signed") };
		const llm = { isConfigured: () => true, complete: jest.fn().mockResolvedValue(llmText === null ? null : { text: llmText, provider: "gemini" }) };
		global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("%PDF").buffer }) as never;
		const service = new DocumentReviewService(userModel as never, uploads as never, llm as never, { get: () => "test" } as never, storage as never);
		return { service, userModel, uploads, llm };
	}
	const pending = { type: DocumentType.STUDENT_STATUS, key: "private/u1/a.pdf", status: DocumentStatus.PENDING };

	it("sends the private file to the AI chain and stores the outcome", async () => {
		const { service, userModel, uploads, llm } = setup(pending, JSON.stringify({ ...ok, expiryDate: "2027-06-30", reason: "ok" }));
		await service.review("u1", DocumentType.STUDENT_STATUS, now);

		expect(uploads.getPresignedDownloadUrl).toHaveBeenCalledWith("private/u1/a.pdf", "private", 120);
		expect(llm.complete.mock.calls[0][0].file).toEqual({ mimeType: "application/pdf", data: Buffer.from("%PDF").toString("base64") });
		expect(userModel.updateOne).toHaveBeenCalledWith(
			// The name read is part of the filter: a rename during the AI call writes nothing.
			{ _id: "u1", name: "Chloe Dubois", documents: { $elemMatch: { type: DocumentType.STUDENT_STATUS, key: "private/u1/a.pdf", status: DocumentStatus.PENDING } } },
			{ $set: { "documents.$.status": DocumentStatus.VERIFIED, "documents.$.rejectionReason": null, "documents.$.expiresAt": new Date("2027-06-30T23:59:59Z") } }
		);
	});

	it("leaves the document PENDING for the sweep when the AI is unavailable, counting the try", async () => {
		const { service, userModel } = setup(pending, null);
		await service.review("u1", DocumentType.STUDENT_STATUS, now);
		expect(userModel.updateOne).toHaveBeenCalledTimes(1);
		expect(userModel.updateOne.mock.calls[0][1]).toEqual({ $inc: { "documents.$.reviewAttempts": 1 }, $set: { "documents.$.lastReviewAt": now } });
	});

	it("rejects a file that is not in storage instead of leaving it PENDING forever", async () => {
		const { service, userModel, llm } = setup(pending, "{}");
		global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
		await service.review("u1", DocumentType.STUDENT_STATUS, now);
		expect(llm.complete).not.toHaveBeenCalled();
		expect(userModel.updateOne.mock.calls[1][1].$set).toEqual({ "documents.$.status": DocumentStatus.REJECTED, "documents.$.rejectionReason": expect.stringMatching(/couldn't open this file/) });
	});

	it("gives up after the last try and tells the student what to upload", async () => {
		const { service, userModel, llm } = setup({ ...pending, reviewAttempts: MAX_REVIEW_ATTEMPTS }, "{}");
		await service.review("u1", DocumentType.STUDENT_STATUS, now);
		expect(llm.complete).not.toHaveBeenCalled();
		expect(userModel.updateOne).toHaveBeenCalledWith(
			expect.objectContaining({ _id: "u1" }),
			{ $set: { "documents.$.status": DocumentStatus.REJECTED, "documents.$.rejectionReason": expect.stringMatching(/Upload it again as a PDF/) } }
		);
	});

	it("over the daily limit, moves lastReviewAt so the hourly backoff applies, without using a try", async () => {
		const storage = { increment: jest.fn().mockResolvedValue({ isBlocked: true }) };
		const { service, userModel, llm } = setup(pending, "{}", storage);
		await service.review("u1", DocumentType.STUDENT_STATUS, now);
		expect(llm.complete).not.toHaveBeenCalled();
		expect(userModel.updateOne).toHaveBeenCalledTimes(1);
		expect(userModel.updateOne.mock.calls[0][1]).toEqual({ $set: { "documents.$.lastReviewAt": now } });
	});

	it("never sends identity documents to the AI", async () => {
		const { service, userModel, llm } = setup({ ...pending, type: DocumentType.PASSPORT }, "{}");
		await service.review("u1", DocumentType.PASSPORT, now);
		expect(userModel.findById).not.toHaveBeenCalled();
		expect(llm.complete).not.toHaveBeenCalled();
	});
});

describe("DocumentReviewService.sweep", () => {
	it("only reviews the uploads the query found due, not every PENDING one of that student", async () => {
		const old = new Date(now.getTime() - 2 * 3600_000);
		const docs = [
			{ type: DocumentType.STUDENT_STATUS, status: DocumentStatus.PENDING, uploadedAt: old },
			{ type: DocumentType.PROOF_OF_FUNDS, status: DocumentStatus.PENDING, uploadedAt: new Date(now.getTime() - 30_000) },
			{ type: DocumentType.PROOF_OF_INCOME, status: DocumentStatus.PENDING, uploadedAt: old, lastReviewAt: new Date(now.getTime() - 600_000) }
		];
		const userModel = {
			updateMany: jest.fn().mockResolvedValue({}),
			find: jest.fn(() => ({ limit: () => ({ lean: () => ({ exec: async () => [{ _id: "u1", documents: docs }] }) }) }))
		};
		const service = new DocumentReviewService(userModel as never, {} as never, {} as never, { get: () => "test" } as never);
		const review = jest.spyOn(service, "review").mockResolvedValue(undefined);
		await service.sweep(now);
		expect(review.mock.calls).toEqual([["u1", DocumentType.STUDENT_STATUS, now]]);
	});
});

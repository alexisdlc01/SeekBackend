import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { DocumentType } from "./types/document-type";
import UsersService from "./users.service";

describe("UsersService", () => {
	let service: UsersService;
	let userModel: {
		findByIdAndUpdate: jest.Mock;
		updateOne: jest.Mock;
	};

	beforeEach(() => {
		userModel = {
			findByIdAndUpdate: jest.fn(),
			updateOne: jest.fn().mockResolvedValue({})
		};
		service = new UsersService(userModel as never, {} as never, {} as never);
	});

	it("emails a referee before saving the pending request, and saves nothing when the email fails", async () => {
		const updateOne = jest.fn().mockResolvedValue({});
		const sendReferenceRequest = jest.fn().mockResolvedValue(undefined);
		const model = { updateOne, findById: () => ({ lean: () => ({ exec: async () => ({ documents: [], referenceRequests: [] }) }) }) };
		const users = new UsersService(model as never, {} as never, { sendReferenceRequest } as never);
		const student = { _id: "u1", name: "Sam", email: "sam@example.com" } as never;
		const body = { type: DocumentType.AGENT_REFERENCE, name: " Bristol Lets ", email: "Lets@Agent.co.uk" } as const;

		await users.requestReference(student, body);
		expect(sendReferenceRequest).toHaveBeenCalledWith(
			{ name: "Bristol Lets", email: "lets@agent.co.uk" }, { name: "Sam", email: "sam@example.com" },
			"Letting agent reference for Sam", expect.any(String)
		);
		expect(updateOne).toHaveBeenLastCalledWith({ _id: "u1" }, {
			$push: { referenceRequests: { type: DocumentType.AGENT_REFERENCE, name: "Bristol Lets", email: "lets@agent.co.uk", requestedAt: expect.any(Date) } }
		});

		updateOne.mockClear();
		sendReferenceRequest.mockRejectedValue(new Error("mailgun down"));
		await expect(users.requestReference(student, body)).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(updateOne).not.toHaveBeenCalled();
		await expect(users.requestReference(student, { ...body, email: "SAM@example.com" })).rejects.toBeInstanceOf(BadRequestException);
	});

	it("should be defined", () => {
		expect(service).toBeDefined();
	});

	it("normalizes and updates the current user's profile", async () => {
		const saved = {
			toObject: () => ({
				_id: "user-1",
				name: "Rinat",
				email: "rinat@example.com",
				username: "rinat.dev",
				phone: "+44 1234",
				dateOfBirth: new Date("2001-03-04"),
				universityDetails: "University of St Andrews"
			})
		};
		userModel.findByIdAndUpdate.mockResolvedValue(saved);

		const result = await service.updateProfile("user-1", {
			name: "  Rinat  ",
			username: "  Rinat.Dev ",
			phone: " +44 1234 ",
			dateOfBirth: "2001-03-04",
			universityDetails: " University of St Andrews "
		});

		expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(
			"user-1",
			{
				$set: {
					name: "Rinat",
					username: "rinat.dev",
					phone: "+44 1234",
					dateOfBirth: new Date("2001-03-04"),
					universityDetails: "University of St Andrews"
				}
			},
			{ new: true, runValidators: true, upsert: false }
		);
		expect(result.username).toBe("rinat.dev");
		// A new name sends documents verified, or rejected (name mismatch), against the old one back to the automatic check.
		const checked = { $in: ["VERIFIED", "REJECTED"] };
		expect(userModel.updateOne).toHaveBeenCalledWith(
			{ _id: "user-1", name: { $ne: "Rinat" }, documents: { $elemMatch: { type: { $nin: expect.any(Array) }, status: checked } } },
			{ $set: { "documents.$[doc].status": "PENDING", "documents.$[doc].rejectionReason": null, "documents.$[doc].reviewAttempts": 0, "documents.$[doc].lastReviewAt": null } },
			{ arrayFilters: [{ "doc.type": { $nin: expect.arrayContaining(["PASSPORT"]) }, "doc.status": checked }] }
		);
	});

	it("unsets optional fields when they are cleared", async () => {
		userModel.findByIdAndUpdate.mockResolvedValue({
			toObject: () => ({
				_id: "user-1",
				name: "Rinat",
				email: "rinat@example.com"
			})
		});

		await service.updateProfile("user-1", {
			username: "",
			phone: "",
			dateOfBirth: "",
			universityDetails: ""
		});

		expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(
			"user-1",
			{
				$unset: {
					username: 1,
					phone: 1,
					dateOfBirth: 1,
					universityDetails: 1
				}
			},
			{ new: true, runValidators: true, upsert: false }
		);
	});

	it("returns a useful conflict for duplicate usernames", async () => {
		userModel.findByIdAndUpdate.mockRejectedValue({
			code: 11000,
			keyPattern: { username: 1 }
		});

		await expect(
			service.updateProfile("user-1", { username: "already.used" })
		).rejects.toThrow(new ConflictException("Username already in use."));
	});

	it("never writes email through the profile update path", async () => {
		userModel.findByIdAndUpdate.mockResolvedValue({
			toObject: () => ({ _id: "user-1", name: "Rinat" })
		});

		// Email changes must go through the confirmation flow in AuthService,
		// so even a caller that smuggles the field past validation cannot take
		// ownership of an address it has not proven.
		await service.updateProfile("user-1", {
			name: "Rinat",
			email: "victim@example.com"
		} as never);

		const [, update] = userModel.findByIdAndUpdate.mock.calls[0];
		expect(update.$set).not.toHaveProperty("email");
		expect(update.$unset).toBeUndefined();
	});

	describe("addDocument", () => {
		const OWNED_KEY =
			"private/507f1f77bcf86cd799439011/123e4567-e89b-12d3-a456-426614174000.pdf";

		beforeEach(() => {
			(userModel as Record<string, unknown>).bulkWrite = jest
				.fn()
				.mockResolvedValue({ matchedCount: 1 });
		});

		it("accepts a key issued to the calling user", async () => {
			await expect(
				service.addDocument(
					"507f1f77bcf86cd799439011",
					"IDENTIFICATION" as never,
					"https://example.com/doc.pdf",
					OWNED_KEY
				)
			).resolves.toMatchObject({ message: "Document added successfully" });
		});

		it("marks identity uploads PROVIDED without a review, and reviews the rest in the background", async () => {
			const review = jest.fn().mockResolvedValue(undefined);
			const users = new UsersService(userModel as never, {} as never, {} as never, undefined, { review } as never);
			const pushed = () => (userModel as unknown as { bulkWrite: jest.Mock }).bulkWrite.mock.calls.at(-1)[0][1].updateOne.update.$push.documents.status;

			await users.addDocument("507f1f77bcf86cd799439011", DocumentType.PASSPORT, "https://example.com/doc.pdf", OWNED_KEY);
			expect(pushed()).toBe("PROVIDED");
			expect(review).not.toHaveBeenCalled();

			await users.addDocument("507f1f77bcf86cd799439011", DocumentType.PROOF_OF_FUNDS, "https://example.com/doc.pdf", OWNED_KEY);
			expect(pushed()).toBe("PENDING");
			expect(review).toHaveBeenCalledWith("507f1f77bcf86cd799439011", DocumentType.PROOF_OF_FUNDS);
		});

		it("rejects a key issued to a different user", async () => {
			await expect(
				service.addDocument(
					"507f1f77bcf86cd799439012",
					"IDENTIFICATION" as never,
					"https://example.com/doc.pdf",
					OWNED_KEY
				)
			).rejects.toThrow("Document key was not issued to this account.");
		});

		it("rejects a public/ key even when it is owned by the user", async () => {
			await expect(
				service.addDocument(
					"507f1f77bcf86cd799439011",
					"IDENTIFICATION" as never,
					"https://example.com/doc.pdf",
					OWNED_KEY.replace("private/", "public/")
				)
			).rejects.toThrow("Documents must be uploaded privately.");
		});

		it("rejects an unscoped legacy-shaped key", async () => {
			await expect(
				service.addDocument(
					"507f1f77bcf86cd799439011",
					"IDENTIFICATION" as never,
					"https://example.com/doc.pdf",
					"private/1750000000000-passport.pdf"
				)
			).rejects.toThrow("Document key was not issued to this account.");
		});
	});

	it("lists PENDING uploads oldest first with a signed private link only", async () => {
		const find = jest.fn().mockReturnValue({ lean: () => ({ exec: async () => [
			{ _id: { toString: () => "u1" }, name: "Maya", email: "maya@ucl.ac.uk", documents: [
				{ type: DocumentType.PASSPORT, status: "PENDING", key: "private/u1/a.pdf", url: "https://bucket/private/u1/a.pdf", uploadedAt: new Date("2026-11-05") },
				{ type: DocumentType.RIGHT_TO_RENT, status: "VERIFIED", key: "private/u1/b.pdf", uploadedAt: new Date("2026-11-01") }
			] },
			{ _id: { toString: () => "u2" }, name: "Sam", email: "sam@kcl.ac.uk", documents: [
				{ type: DocumentType.PROOF_OF_FUNDS, status: "PENDING", key: "public/old.pdf", url: "https://bucket/public/old.pdf", uploadedAt: new Date("2026-11-02") }
			] }
		] }) });
		const getPresignedDownloadUrl = jest.fn().mockResolvedValue("https://signed");
		const users = new UsersService({ find } as never, {} as never, {} as never, { getPresignedDownloadUrl } as never);

		const pending = await users.listPendingDocuments();

		expect(find.mock.calls[0][0]).toEqual({ deletedAt: null, documents: { $elemMatch: { status: "PENDING" } } });
		expect(pending.map(p => [p.userId, p.type, p.url])).toEqual([
			["u2", DocumentType.PROOF_OF_FUNDS, null],
			["u1", DocumentType.PASSPORT, "https://signed"]
		]);
		expect(pending[1]).toMatchObject({ name: "Maya", email: "maya@ucl.ac.uk" });
		expect(getPresignedDownloadUrl).toHaveBeenCalledTimes(1);
		expect(getPresignedDownloadUrl).toHaveBeenCalledWith("private/u1/a.pdf", "private", 600);
	});

	it("staff can only re-run the automatic check: never verify a document by hand, never touch identity documents", async () => {
		const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
		const review = { review: jest.fn().mockResolvedValue(undefined) };
		const users = new UsersService({ updateOne } as never, {} as never, {} as never, undefined, review as never);
		jest.spyOn(users, "getPassport").mockResolvedValue({} as never);

		await expect(users.setDocumentStatus("u1", DocumentType.PASSPORT, "PENDING" as never)).rejects.toThrow("landlord checks them");
		await expect(users.setDocumentStatus("u1", DocumentType.PROOF_OF_FUNDS, "VERIFIED" as never)).rejects.toThrow("checked automatically");
		expect(updateOne).not.toHaveBeenCalled();

		await users.setDocumentStatus("u1", DocumentType.PROOF_OF_FUNDS, "PENDING" as never);
		expect(updateOne.mock.calls[0][1].$set).toMatchObject({ "documents.$.status": "PENDING", "documents.$.reviewAttempts": 0 });
		expect(review.review).toHaveBeenCalledWith("u1", DocumentType.PROOF_OF_FUNDS);
	});

	it("refuses a suspended account's session, so open sockets are cut at their next revalidation", async () => {
		const session = { sessionId: "s1", expiresAt: new Date(Date.now() + 60_000) };
		const getUserById = jest.fn().mockResolvedValue({ _id: "u1", refreshSessions: [session], suspendedAt: new Date() });
		const users = new UsersService({} as never, { getUserById } as never, {} as never);
		await expect(users.getUserForSession("u1", "s1")).rejects.toThrow("Session not found.");
		getUserById.mockResolvedValue({ _id: "u1", refreshSessions: [session], suspendedAt: null });
		await expect(users.getUserForSession("u1", "s1")).resolves.toMatchObject({ _id: "u1" });
	});
});

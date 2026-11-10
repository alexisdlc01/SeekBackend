import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { DocumentType } from "./types/document-type";
import UsersService from "./users.service";

describe("UsersService", () => {
	let service: UsersService;
	let userModel: {
		findByIdAndUpdate: jest.Mock;
	};

	beforeEach(() => {
		userModel = {
			findByIdAndUpdate: jest.fn()
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
		expect(getPresignedDownloadUrl).toHaveBeenCalledWith("private/u1/a.pdf", "private");
	});
});

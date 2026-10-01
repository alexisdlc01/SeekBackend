import { ConflictException } from "@nestjs/common";
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
		service = new UsersService(userModel as never, {} as never);
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
});

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
			email: "  RINAT@EXAMPLE.COM ",
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
					email: "rinat@example.com",
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
});

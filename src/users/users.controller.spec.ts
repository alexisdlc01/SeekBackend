import { ROLE_KEY } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { UsersController } from "./users.controller";

describe("UsersController", () => {
	let controller: UsersController;
	let usersService: {
		updateProfile: jest.Mock;
	};

	beforeEach(() => {
		usersService = {
			updateProfile: jest.fn()
		};
		controller = new UsersController(usersService as never, {} as never, {} as never, {} as never);
	});

	it("should be defined", () => {
		expect(controller).toBeDefined();
	});

	it("updates the authenticated user's profile", async () => {
		usersService.updateProfile.mockResolvedValue({ name: "Updated" });
		const user = { _id: { toString: () => "user-1" }, role: "STUDENT" };

		await controller.updateCurrentUser(
			{ name: "Updated" },
			user as never
		);

		expect(usersService.updateProfile).toHaveBeenCalledWith(
			"user-1",
			{ name: "Updated" },
			"STUDENT"
		);
	});

	it("keeps the pending-documents queue staff only", () => {
		expect(Reflect.getMetadata(ROLE_KEY, UsersController.prototype.listPendingDocuments)).toEqual([Role.SUPERUSER]);
	});
});

import { ROLE_KEY } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { ThrottlerStorageService } from "@nestjs/throttler";
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
		controller = new UsersController(usersService as never, {} as never, {} as never, {} as never, {} as never);
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

	it("answers 429 after 10 team invites an hour for one landlord", async () => {
		const storage = new ThrottlerStorageService();
		try {
			const account = { invite: jest.fn().mockResolvedValue({}) };
			const invites = new UsersController({} as never, {} as never, account as never, {} as never, storage);
			const user = { _id: "owner-1" } as never;
			for (let i = 0; i < 10; i++) await invites.inviteTeamMember({} as never, user);
			await expect(invites.inviteTeamMember({} as never, user)).rejects.toMatchObject({ status: 429 });
			expect(account.invite).toHaveBeenCalledTimes(10);
		} finally {
			storage.onApplicationShutdown();
		}
	});
});

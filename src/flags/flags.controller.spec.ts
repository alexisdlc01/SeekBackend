import { ROLE_KEY } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { FlagsController } from "./flags.controller";
import { FlagsService } from "./flags.service";

describe("FlagsController", () => {
	it("marks the all-reports endpoint as superuser-only", () => {
		const roles = Reflect.getMetadata(
			ROLE_KEY,
			FlagsController.prototype.getAll
		);
		expect(roles).toEqual([Role.SUPERUSER]);
	});

	it("delegates report listing to the service", async () => {
		const flagsService = {
			getAll: jest.fn().mockResolvedValue([])
		} as unknown as FlagsService;
		const controller = new FlagsController(flagsService);
		await expect(controller.getAll()).resolves.toEqual([]);
	});
});

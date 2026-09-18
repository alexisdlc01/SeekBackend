import { Role } from "../auth/role.enum";
import { AccessControlService } from "./access-control.service";

describe("AccessControlService", () => {
	const service = new AccessControlService();

	it.each(Object.values(Role))("allows %s to use its own role", role => {
		expect(
			service.isAuthorized({ currentRole: role, requiredRole: role })
		).toBe(true);
	});

	it.each([
		[Role.STUDENT, Role.LANDLORD_AGENCY],
		[Role.STUDENT, Role.SUPERUSER],
		[Role.LANDLORD_AGENCY, Role.STUDENT],
		[Role.LANDLORD_AGENCY, Role.SUPERUSER],
		[Role.SUPERUSER, Role.STUDENT],
		[Role.SUPERUSER, Role.LANDLORD_AGENCY]
	])("does not let %s inherit %s permissions", (currentRole, requiredRole) => {
		expect(
			service.isAuthorized({ currentRole, requiredRole })
		).toBe(false);
	});
});

import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Types } from "mongoose";
import { RoleGuard } from "./role.guard";
import { AccessControlService } from "../../shared/access-control.service";
import { ROLE_KEY } from "../decorators/role.decorator";
import { TEAM_SCOPES_KEY } from "../decorators/team-access.decorator";
import { Role } from "../role.enum";
import { TeamScope } from "../../users/types/team-scope";

describe("RoleGuard team access", () => {
	const owner = { _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY, name: "James" };
	const agent = () => ({
		_id: new Types.ObjectId(),
		role: Role.LANDLORD_AGENCY,
		name: "Priya",
		authSessionId: "s1",
		teamMembership: { owner: { ...owner }, scopes: [TeamScope.VIEWINGS_INBOX] }
	});

	function run(user: Record<string, unknown>, teamScopes: TeamScope[] | undefined) {
		const request = { user };
		const reflector = {
			getAllAndOverride: (key: string) => (key === ROLE_KEY ? [Role.LANDLORD_AGENCY] : key === TEAM_SCOPES_KEY ? teamScopes : undefined)
		} as unknown as Reflector;
		const context = {
			getHandler: () => null,
			getClass: () => null,
			switchToHttp: () => ({ getRequest: () => request })
		} as unknown as ExecutionContext;
		const result = new RoleGuard(reflector, new AccessControlService()).canActivate(context);
		return { result, request };
	}

	it("lets a member act as the owner within their scopes", () => {
		const { result, request } = run(agent(), [TeamScope.VIEWINGS_INBOX, TeamScope.APPLICATIONS]);
		expect(result).toBe(true);
		expect((request.user as { _id: Types.ObjectId })._id).toBe(owner._id);
		expect((request.user as { actingMember?: { name: string } }).actingMember?.name).toBe("Priya");
	});

	it("refuses a member outside their scopes and on owner-only handlers", () => {
		expect(() => run(agent(), [TeamScope.TENANCIES])).toThrow(ForbiddenException);
		expect(() => run(agent(), [])).toThrow("Only the account owner can see payouts and payments.");
	});

	it("leaves the caller as themselves on unscoped handlers and for owners", () => {
		const member = agent();
		expect(run(member, undefined).request.user).toBe(member);
		const self = { ...owner };
		expect(run(self, []).request.user).toBe(self);
	});
});

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { ROLE_KEY } from "../decorators/role.decorator";
import { Role } from "../role.enum";
import { AccessControlService } from "../../shared/access-control.service";
import { UserDto } from "../../users/dto/user.dto";
import { TEAM_SCOPES_KEY } from "../decorators/team-access.decorator";
import { TeamScope } from "../../users/types/team-scope";
import type { TeamMembership } from "../auth.service";

@Injectable()
export class RoleGuard implements CanActivate {
	constructor(
		private reflector: Reflector,
		private accessControlService: AccessControlService
	) {}

	canActivate(
		context: ExecutionContext
	): boolean | Promise<boolean> | Observable<boolean> {
		const requiredRoles = this.reflector.getAllAndOverride<Role[]>(
			ROLE_KEY,
			[context.getHandler(), context.getClass()]
		);

		const request = context.switchToHttp().getRequest();
		const user = request["user"] as UserDto | undefined;

		// A handler with no @Roles metadata, or a request that never resolved a
		// user, is a misconfiguration — deny explicitly rather than throwing a
		// TypeError that surfaces as an opaque 500.
		if (!requiredRoles?.length || !user?.role) {
			return false;
		}

		const allowed = requiredRoles.some(role =>
			this.accessControlService.isAuthorized({ requiredRole: role, currentRole: user.role })
		);
		if (!allowed) return false;

		// A team member acts as their owner, within their scopes; owner-only handlers refuse them.
		const scopes = this.reflector.getAllAndOverride<TeamScope[] | undefined>(TEAM_SCOPES_KEY, [
			context.getHandler(),
			context.getClass()
		]);
		const membership = (user as UserDto & { teamMembership?: TeamMembership }).teamMembership;
		if (scopes && membership) {
			if (!scopes.some(scope => membership.scopes.includes(scope))) {
				throw new ForbiddenException(
					scopes.length
						? "Your team access doesn't cover this. Ask the account owner to add it."
						: "Only the account owner can see payouts and payments."
				);
			}
			request["user"] = Object.assign(membership.owner, {
				authSessionId: (user as { authSessionId?: string }).authSessionId,
				actingMember: { _id: user._id, name: user.name, scopes: membership.scopes }
			});
		}
		return true;
	}
}

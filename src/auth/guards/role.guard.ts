import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { ROLE_KEY } from "../decorators/role.decorator";
import { Role } from "../role.enum";
import { AccessControlService } from "../../shared/access-control.service";
import { UserDto } from "../../users/dto/user.dto";

export class TokenDto {
	id: number;
	role: Role;
}

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
		const user = request["user"] as UserDto;

		for (let role of requiredRoles) {
			const result = this.accessControlService.isAuthorized({
				requiredRole: role,
				currentRole: user.role
			});

			if (result) {
				return true;
			}
		}

		return false;
	}
}

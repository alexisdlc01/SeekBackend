import { Injectable } from "@nestjs/common";
import { Role } from "../auth/role.enum";

interface IsAuthorizedParams {
	currentRole: Role;
	requiredRole: Role;
}

@Injectable()
export class AccessControlService {
	public isAuthorized({ currentRole, requiredRole }: IsAuthorizedParams) {
		return currentRole === requiredRole;
	}
}

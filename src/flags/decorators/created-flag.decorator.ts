import { applyDecorators, UseGuards } from "@nestjs/common";
import { Roles } from "../../auth/decorators/role.decorator";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RoleGuard } from "../../auth/guards/role.guard";
import { Role } from "../../auth/role.enum";
import { CreatedFlagOrSuperuserGuard } from "../guards/owns-flag.gaurd";

export function CreatedFlagOrSuperuser() {
	return applyDecorators(
		Roles(Role.STUDENT, Role.LANDLORD_AGENCY, Role.SUPERUSER),
		UseGuards(JwtAuthGuard, RoleGuard, CreatedFlagOrSuperuserGuard)
	);
}

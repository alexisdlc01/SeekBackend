import { applyDecorators, UseGuards } from "@nestjs/common";
import { Roles } from "src/auth/decorators/role.decorator";
import { JwtAuthGuard } from "src/auth/guards/jwt-auth.guard";
import { RoleGuard } from "src/auth/guards/role.guard";
import { Role } from "src/auth/role.enum";
import { CreatedFlagOrSuperuserGuard } from "../guards/owns-flag.gaurd";

export function CreatedFlagOrSuperuser() {
	return applyDecorators(
		Roles(Role.STUDENT, Role.SUPERUSER),
		UseGuards(JwtAuthGuard, RoleGuard, CreatedFlagOrSuperuserGuard)
	);
}

import { applyDecorators, UseGuards } from "@nestjs/common";
import { ApplicantGuard } from "../guards/applicant.guard";
import { Roles } from "../../auth/decorators/role.decorator";
import { Role } from "../../auth/role.enum";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RoleGuard } from "../../auth/guards/role.guard";

export function Applicant() {
	return applyDecorators(
		Roles(Role.STUDENT),
		UseGuards(JwtAuthGuard, RoleGuard, ApplicantGuard)
	);
}

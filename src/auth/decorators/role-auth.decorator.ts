import { applyDecorators, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../guards/jwt-auth.guard";
import { RoleGuard } from "../guards/role.guard";
import { Roles } from "./role.decorator";
import { Role } from "../role.enum";

export function Student() {
	return applyDecorators(
		Roles(Role.STUDENT),
		UseGuards(JwtAuthGuard, RoleGuard)
	);
}

export function Superuser() {
	return applyDecorators(
		Roles(Role.SUPERUSER),
		UseGuards(JwtAuthGuard, RoleGuard)
	);
}

export function LandlordAgency() {
	return applyDecorators(
		Roles(Role.LANDLORD_AGENCY),
		UseGuards(JwtAuthGuard, RoleGuard)
	);
}

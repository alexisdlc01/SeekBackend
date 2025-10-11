import { applyDecorators, UseGuards } from "@nestjs/common";
import { OwnsListingGuard } from "./guards/owns-listing.guard";
import { Roles } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RoleGuard } from "../auth/guards/role.guard";

export function OwnsListing() {
	return applyDecorators(
		Roles(Role.LANDLORD_AGENCY),
		UseGuards(JwtAuthGuard, RoleGuard, OwnsListingGuard)
	);
}

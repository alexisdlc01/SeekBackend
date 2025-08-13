import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CreateListingDto } from "./dto/create-listing.dto";
import { Roles } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RoleGuard } from "../auth/guards/role.guard";

@Controller("listings")
export class ListingsController {
	@Post("/create")
	@Roles(Role.LANDLORD_AGENCY)
	@UseGuards(JwtAuthGuard, RoleGuard)
	create(@Body() body: CreateListingDto) {
		// TODO: Create a listing.
	}

	@Get("/mine")
	@Roles(Role.LANDLORD_AGENCY)
	@UseGuards(JwtAuthGuard, RoleGuard)
	myListings() {
		// TODO: Return all of landlords listings.
	}

	@Get("/:id")
	getById(@Param("id") id: string) {
		// TODO: Return the listing by the id
	}
}

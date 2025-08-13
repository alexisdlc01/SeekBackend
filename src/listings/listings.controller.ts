import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CreateListingDto } from "./dto/create-listing.dto";
import { Roles } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RoleGuard } from "../auth/guards/role.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ListingsService } from "./listings.service";

@Controller("listings")
export class ListingsController {
	constructor(private readonly listingsService: ListingsService) {}

	@Post("/create")
	@Roles(Role.LANDLORD_AGENCY)
	@UseGuards(JwtAuthGuard, RoleGuard)
	async create(@CurrentUser() user: User, @Body() body: CreateListingDto) {
		await this.listingsService.create(body, user);
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

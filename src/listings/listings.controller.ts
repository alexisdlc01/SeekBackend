import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CreateListingDto } from "./dto/create-listing.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ListingsService } from "./listings.service";
import {
	LandlordAgency,
	Superuser
} from "../auth/decorators/role-auth.decorator";

@Controller("listings")
export class ListingsController {
	constructor(private readonly listingsService: ListingsService) {}

	@Post("/create")
	@LandlordAgency()
	async create(@CurrentUser() user: User, @Body() body: CreateListingDto) {
		await this.listingsService.create(body, user);
	}

	@Get("/mine")
	@LandlordAgency()
	async myListings(@CurrentUser() user: User) {
		return await this.listingsService.findByLandlord(user._id.toString());
	}

	@Get("/:id")
	@Superuser()
	async getById(@Param("id") id: string) {
		return await this.listingsService.findListingById(id);
	}

	@Patch("/verify/:id")
	@Superuser()
	async verifyListing(@Param("id") id: string) {
		await this.listingsService.verifyListing(id);
	}
}

import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import {
	CreateListingDto,
	Step1ListingDto,
	Step2ListingDto,
	Step3ListingDto
} from "./dto/create-listing.dto";
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

	@Post("/draft")
	@LandlordAgency()
	async createDraft(@CurrentUser() user: User) {
		return this.listingsService.createDraft(user);
	}

	@Patch(":id/createStep1")
	@LandlordAgency()
	async createStep1(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step1ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep2")
	@LandlordAgency()
	async createStep2(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step2ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep3")
	@LandlordAgency()
	async createStep3(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step3ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Post(":id/publish")
	@LandlordAgency()
	async publish(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: CreateListingDto
	) {
		await this.listingsService.updateDraft(listingId, user, body);
		return this.listingsService.publishDraft(listingId, user);
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

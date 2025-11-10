import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post
} from "@nestjs/common";
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
import { MailService } from "../auth/mail.service";
import { OwnsListing } from "./decorators/owns-listing.decorator";
import { ApiBody, ApiResponse } from "@nestjs/swagger";
import { Listing } from "./listings.schema";
import { ErrorDto } from "src/dto/errorDto.dto";

@Controller("listings")
export class ListingsController {
	constructor(
		private readonly listingsService: ListingsService,
		private readonly mailService: MailService
	) { }

	@Post("/draft")
	@LandlordAgency()
	@ApiResponse({
		status: 201,
		type: String,
	})
	@ApiResponse({ status: 401, type: ErrorDto })
	async createDraft(@CurrentUser() user: User) {
		return await this.listingsService.createDraft(user);
	}

	@Patch(":id/createStep1")
	@OwnsListing()
	@ApiBody({ type: CreateListingDto })
	@ApiResponse({ status: 204, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async createStep1(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step1ListingDto
	) {
		return await this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep2")
	@OwnsListing()
	@ApiBody({ type: Step2ListingDto })
	@ApiResponse({ status: 204, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async createStep2(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step2ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep3")
	@OwnsListing()
	@ApiBody({ type: Step3ListingDto })
	@ApiResponse({ status: 204, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
@ApiResponse({ status: 404, type: ErrorDto })
	async createStep3(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step3ListingDto
	) {
		console.log("here", body);
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Post(":id/publish")
	@OwnsListing()
	@ApiBody({ type: CreateListingDto })
	@ApiResponse({ status: 204, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async publish(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: CreateListingDto
	) {
		await this.listingsService.updateDraft(listingId, user, body);
		await this.mailService.sendNewListingEmail(user);
		return this.listingsService.publishDraft(listingId, user);
	}

	@Delete(":id")
	@OwnsListing()
	@ApiResponse({ status: 204, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 401, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async deleteListing(
		@CurrentUser() user: User,
		@Param("id") listingId: string
	) {
		return await this.listingsService.deleteListing(listingId, user);
	}

	@Get("/mine")
	@LandlordAgency()
	@ApiResponse({ status: 200, type: Array<Listing> })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 401, type: ErrorDto })
	async myListings(@CurrentUser() user: User) {
		return await this.listingsService.findByLandlord(user._id.toString());
	}

	@Get("/mine/:id")
	@OwnsListing()
	@ApiResponse({ status: 200, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async getListing(@Param("id") listingId: string) {
		return this.listingsService.findListingById(listingId);
	}

	@Get("allUnverified")
	@Superuser()
	@ApiResponse({ status: 200, type: Array<Listing> })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 401, type: ErrorDto })
	async getAllUnverifiedListings() {
		return await this.listingsService.getAllUnverifiedListings();
	}

	@Get("/:id")
	@Superuser()
	@ApiResponse({ status: 200, type: Listing })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 401, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async getById(@Param("id") id: string) {
		return await this.listingsService.findListingById(id);
	}

	@Patch("/verify/:id")
	@Superuser()
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 401, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async verifyListing(@Param("id") id: string) {
		await this.listingsService.verifyListing(id);
	}
}

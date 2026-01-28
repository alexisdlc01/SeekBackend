import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query
} from "@nestjs/common";
import {
	CreateListingDto,
	Step1ListingDto,
	Step2ListingDto,
	Step3ListingDto,
	Step4ListingDto
} from "./dto/create-listing.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ListingsService } from "./listings.service";
import {
	LandlordAgency,
	Student,
	Superuser
} from "../auth/decorators/role-auth.decorator";
import { MailService } from "../auth/mail.service";
import { OwnsListing } from "./decorators/owns-listing.decorator";
import {
	ApiCreateStep1Docs,
	ApiCreateStep2Docs,
	ApiCreateStep3Docs,
	ApiDeleteListingDocs,
	ApiDraftDocs,
	ApiGetAllUnverifiedDocs,
	ApiGetAllVerifiedDocs,
	ApiGetByIdDocs,
	ApiGetListingDocs,
	ApiLikedListingsDocs,
	ApiLikeListingDocs,
	ApiMyListingsDocs,
	ApiPublishDocs,
	ApiUnlikeListingDocs,
	ApiVerifyListingDocs
} from "./swagger/listings-swagger.decorator";
import { ListingFilterDto } from "./dto/listing-filter.dto";

@Controller("listings")
export class ListingsController {
	constructor(
		private readonly listingsService: ListingsService,
		private readonly mailService: MailService
	) { }

	@Post("/draft")
	@LandlordAgency()
	@ApiDraftDocs()
	async createDraft(@CurrentUser() user: User) {
		return await this.listingsService.createDraft(user);
	}

	@Patch(":id/createStep1")
	@OwnsListing()
	@ApiCreateStep1Docs()
	async createStep1(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step1ListingDto
	) {
		return await this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep2")
	@OwnsListing()
	@ApiCreateStep2Docs()
	async createStep2(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step2ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep3")
	@OwnsListing()
	@ApiCreateStep3Docs()
	async createStep3(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step3ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Patch(":id/createStep4")
	@OwnsListing()
	async createStep4(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step4ListingDto
	) {
		return this.listingsService.updateDraft(listingId, user, body);
	}

	@Post(":id/publish")
	@OwnsListing()
	@ApiPublishDocs()
	async publish(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: CreateListingDto
	) {
		const addressData = await this.listingsService.getCoordinates(
			body.streetAddress,
			body.cityTown,
			body.postcodeZIP,
			body.country
		);
		await this.listingsService.updateDraft(listingId, user, {
			...body,
			formatted_address: addressData.formatted_address,
			location: {
				type: "Point",
				coordinates: [addressData.lng, addressData.lat]
			}
		});
		await this.mailService.sendNewListingEmail(user);
		return this.listingsService.publishDraft(listingId, user);
	}

	@Delete(":id")
	@OwnsListing()
	@ApiDeleteListingDocs()
	async deleteListing(
		@CurrentUser() user: User,
		@Param("id") listingId: string
	) {
		return await this.listingsService.deleteListing(listingId, user);
	}

	@Get("/mine")
	@LandlordAgency()
	@ApiMyListingsDocs()
	async myListings(@CurrentUser() user: User) {
		return await this.listingsService.findByLandlord(user._id.toString());
	}

	@Get("/mine/:id")
	@OwnsListing()
	@ApiGetListingDocs()
	async getListing(@Param("id") listingId: string) {
		return this.listingsService.findListingById(listingId);
	}

	@Get("allUnverified")
	@Superuser()
	@ApiGetAllUnverifiedDocs()
	async getAllUnverifiedListings() {
		return await this.listingsService.getAllUnverifiedListings();
	}

	@Get("allVerified")
	@Student()
	@ApiGetAllVerifiedDocs()
	async getAllVerifiedListings() {
		return await this.listingsService.getAllVerifiedListings();
	}

	@Get("filter")
	@Student()
	async getFilteredListings(@Query() filters: ListingFilterDto) {
		return this.listingsService.filters(filters);
	}

	@Get("/like")
	@Student()
	@ApiLikedListingsDocs()
	async getLiked(@CurrentUser() user: User) {
		return await this.listingsService.getLiked(user);
	}

	@Get("/:id")
	@Student()
	@ApiGetByIdDocs()
	async getById(@Param("id") id: string) {
		return await this.listingsService.findListingById(id);
	}

	@Patch("/verify/:id")
	@Superuser()
	@ApiVerifyListingDocs()
	async verifyListing(@Param("id") id: string) {
		await this.listingsService.verifyListing(id);
	}

	@Patch("/like/:id")
	@Student()
	@ApiLikeListingDocs()
	async likeListing(@Param("id") id: string, @CurrentUser() user: User) {
		await this.listingsService.likeListing(id, user);
	}

	@Patch("/unlike/:id")
	@Student()
	@ApiUnlikeListingDocs()
	async unlikeListing(@Param("id") id: string, @CurrentUser() user: User) {
		await this.listingsService.unlikeListing(id, user);
	}
}

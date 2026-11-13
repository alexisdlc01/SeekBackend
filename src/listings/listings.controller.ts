import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
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
import { ListingModerationService } from "./listing-moderation.service";
import { Listing } from "./listings.schema";
import {
	LandlordAgency,
	Student,
	Superuser
} from "../auth/decorators/role-auth.decorator";
import { OwnsListing } from "./decorators/owns-listing.decorator";
import {
	ApiCreateStep1Docs,
	ApiCreateStep2Docs,
	ApiCreateStep3Docs,
	ApiDeleteListingDocs,
	ApiDraftDocs,
	ApiFilterListingsDocs,
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
import { PublicEndpoint } from "../decorators/public-endpoint.decorator";
import { requiredDocuments } from "../application/required-documents";

@Controller("listings")
export class ListingsController {
	constructor(
		private readonly listingsService: ListingsService,
		private readonly moderation?: ListingModerationService
	) { }

	/** A live listing that is not verified (new content, or waiting on fixes) is re-checked on every save. */
	private async checked(listing: Listing, user: User): Promise<Listing> {
		if (listing.isDraft || listing.isVerified || !this.moderation) return listing;
		return (await this.moderation.moderate(listing._id, user._id.toString())) ?? listing;
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Post("/draft")
	@LandlordAgency()
	@ApiDraftDocs()
	async createDraft(@CurrentUser() user: User) {
		return await this.listingsService.createDraft(user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Patch(":id/createStep1")
	@OwnsListing()
	@ApiCreateStep1Docs()
	async createStep1(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step1ListingDto
	) {
		return this.checked(await this.listingsService.updateDraft(listingId, user, { ...body, draftStep: 1 }), user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Patch(":id/createStep2")
	@OwnsListing()
	@ApiCreateStep2Docs()
	async createStep2(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step2ListingDto
	) {
		return this.checked(await this.listingsService.updateDraft(listingId, user, { ...body, draftStep: 2 }), user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Patch(":id/createStep3")
	@OwnsListing()
	@ApiCreateStep3Docs()
	async createStep3(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step3ListingDto
	) {
		return this.checked(await this.listingsService.updateDraft(listingId, user, { ...body, draftStep: 3 }), user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Patch(":id/createStep4")
	@OwnsListing()
	async createStep4(
		@CurrentUser() user: User,
		@Param("id") listingId: string,
		@Body() body: Step4ListingDto
	) {
		return this.checked(await this.listingsService.updateDraft(listingId, user, { ...body, draftStep: 4 }), user);
	}

	@TeamAccess(TeamScope.LISTINGS)
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
			...(addressData
				? {
					formatted_address: addressData.formatted_address,
					location: {
						type: "Point",
						coordinates: [addressData.lng, addressData.lat]
					}
				}
				: {})
		});
		const published = await this.listingsService.publishDraft(listingId, user);
		// Goes live only once the automatic check passes (no admin queue, no admin email).
		// An approved listing the update left verified stays live: no new AI call that could hide it.
		return this.checked(published, user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Delete(":id")
	@OwnsListing()
	@ApiDeleteListingDocs()
	async deleteListing(
		@CurrentUser() user: User,
		@Param("id") listingId: string
	) {
		return await this.listingsService.deleteListing(listingId, user);
	}

	@TeamAccess(TeamScope.LISTINGS)
	@Get("/mine")
	@LandlordAgency()
	@ApiMyListingsDocs()
	async myListings(@CurrentUser() user: User) {
		return await this.listingsService.findByLandlord(user._id.toString());
	}

	@TeamAccess(TeamScope.LISTINGS)
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
	@PublicEndpoint("List published and verified properties")
	@ApiGetAllVerifiedDocs()
	async getAllVerifiedListings() {
		return await this.listingsService.getAllVerifiedListings();
	}

	@Get("filter")
	@PublicEndpoint("Filter published and verified properties")
	@ApiFilterListingsDocs()
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
	@PublicEndpoint("Get a published and verified property")
	@ApiGetByIdDocs()
	async getById(@Param("id") id: string) {
		const listing = await this.listingsService.findPublishedListingById(id);
		void this.listingsService.recordView(id);
		const viewingSlotAvailability = await this.listingsService.viewingSlotAvailability(listing);
		return {
			...(listing as unknown as { toObject(): Listing }).toObject(),
			viewingSlotAvailability,
			requiredDocuments: requiredDocuments(listing)
		};
	}

	@Patch("/verify/:id")
	@Superuser()
	@ApiVerifyListingDocs()
	async verifyListing(@Param("id") id: string) {
		// No staff approval: this only runs the automatic check again (rules, suspension, anti-scam AI).
		const listing = await this.listingsService.findListingById(id);
		return (await this.moderation?.moderate(listing._id)) ?? listing;
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

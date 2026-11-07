import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { LandlordAgency, Student, StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { Applicant } from "./decorators/applicant.decorator";
import { OwnsListing } from "../listings/decorators/owns-listing.decorator";
import { ApiByConversation, ApiCreateApplicationDocs, ApiGetAllMyApplicationsDocs, ApiGetApplicationById, ApiJoinApplication, ApiSendApplication } from "./swagger/application-swagger.decorator";
import { OwnsAppliedListingGuard } from "./guards/owns-applied-listing.guard";
import { ApplicationOwnerGuard } from "./guards/application-owner.guard";
import { ApplicationAdminGuard } from "./guards/application-admin.guard";
import { OwnsListingParamGuard } from "./guards/owns-listing-param.guard";
import { JoinApplicationDto } from "./dto/join-application.dto";
import { ScheduleViewingDto } from "./dto/viewing.dto";
import { ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import { ApplicationDto } from "./dto/application.dto";
import { RejectApplicationDto } from "./dto/offer.dto";

@Controller("application")
export class ApplicationController {
	constructor(private readonly applicationService: ApplicationService) { }

	@ApiCreateApplicationDocs()
	@Student()
	@Post("create")
	async createApplication(
		@CurrentUser() user: User,
		@Body() body: CreateApplicationDto
	) {
		return await this.applicationService.create(body.listingId, user);
	}

	@ApiJoinApplication()
	@Student()
	@Patch(":id/join")
	async joinApplication(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Query() { invite }: JoinApplicationDto
	) {
		return await this.applicationService.join(
			id,
			user._id.toString(),
			invite
		);
	}

	// Admin-only (creator, or landlord once sent): invites stay under the
	// control of the group's admins rather than anyone who was invited.
	@UseGuards(ApplicationAdminGuard)
	@StudentOrLandlord()
	@TeamAccess(TeamScope.APPLICATIONS)
	@Post(":id/invite")
	async createInvite(@Param("id") id: string) {
		return await this.applicationService.createInvite(id);
	}

	@Applicant()
	@Patch(":id/leave")
	async leaveApplication(
		@CurrentUser() user: User,
		@Param("id") id: string
	) {
		return this.applicationService.leave(id, user._id.toString());
	}

	@ApiSendApplication()
	@UseGuards(ApplicationOwnerGuard)
	@Student()
	@Patch(":id/send")
	async sendApplication(@Param("id") id: string) {
		return this.applicationService.send(id);
	}

	@ApiOperation({ summary: "Book or move the viewing. Landlord or a household member." })
	@StudentOrLandlord()
	@TeamAccess(TeamScope.VIEWINGS_INBOX, TeamScope.APPLICATIONS)
	@Patch(":id/viewing")
	async scheduleViewing(
		@Param("id") id: string,
		@Body() body: ScheduleViewingDto,
		@CurrentUser() user: User,
	) {
		return this.applicationService.scheduleViewing(id, body.viewingAt, user);
	}

	@ApiOperation({ summary: "Accept the next qualified household in the queue. Creates the tenancy and returns its id." })
	@UseGuards(OwnsAppliedListingGuard)
	@LandlordAgency()
	@ApiOkResponse({ description: "The new tenancy's id.", schema: { type: "object", properties: { tenancy: { type: "string" } }, required: ["tenancy"] } })
	@ApiConflictResponse({ description: "Not the next qualified household in this listing's first-come queue." })
	@TeamAccess(TeamScope.APPLICATIONS)
	@Patch(":id/approve")
	async approveApplication(@Param("id") id: string) {
		return await this.applicationService.approve(id);
	}

	@ApiOperation({ summary: "Make an offer. The household has 15 days to accept; the holding deposit is recorded." })
	@UseGuards(OwnsAppliedListingGuard)
	@LandlordAgency()
	@ApiCreatedResponse({ type: ApplicationDto })
	@ApiConflictResponse({ description: "Not the next qualified household in this listing's first-come queue." })
	@TeamAccess(TeamScope.APPLICATIONS)
	@Post(":id/offer")
	async offerApplication(@Param("id") id: string) {
		return await this.applicationService.offer(id);
	}

	@ApiOperation({ summary: "Accept an open offer. Creates the tenancy and returns its id." })
	@Applicant()
	@Patch(":id/accept-offer")
	async acceptOffer(@Param("id") id: string) {
		return await this.applicationService.acceptOffer(id);
	}

	@ApiOperation({ summary: "Decline the household, with an optional reason shown to them." })
	@UseGuards(OwnsAppliedListingGuard)
	@LandlordAgency()
	@TeamAccess(TeamScope.APPLICATIONS)
	@Patch(":id/reject")
	async rejectApplication(@Param("id") id: string, @Body() body: RejectApplicationDto) {
		return await this.applicationService.reject(id, body.reason);
	}

	@ApiJoinApplication()
	@UseGuards(ApplicationOwnerGuard)
	@Student()
	@Patch(":id/delete")
	async deleteApplication(@Param("id") id: string) {
		return this.applicationService.delete(id);
	}


	@UseGuards(OwnsListingParamGuard)
	@LandlordAgency()
	@TeamAccess(TeamScope.VIEWINGS_INBOX, TeamScope.APPLICATIONS)
	@Get("listing/:id")
	async getAllForListing(@Param("id") listingId: string, @CurrentUser() user: User) {
		return this.applicationService.getAllByListing(listingId, user._id.toString());
	}

	@ApiByConversation()
	@StudentOrLandlord()
	@TeamAccess(TeamScope.VIEWINGS_INBOX, TeamScope.APPLICATIONS)
	@Get("conversation/:id")
	async getByConversation(
		@Param("id") conversationId: string,
		@CurrentUser() user: User,
	) {
		return this.applicationService.getByConversation(
			conversationId,
			user._id.toString(),
		);
	}



	@ApiGetAllMyApplicationsDocs()
	@Student()
	@Get("mine")
	async getAllMyApplications(@CurrentUser() user: User) {
		return this.applicationService.getAllMyApplications(
			user._id.toString()
		);
	}

	@ApiGetApplicationById()
	@Applicant()
	@Get(":id")
	async getApplication(@Param("id") id: string) {
		return this.applicationService.findApplicationById(id);
	}
}

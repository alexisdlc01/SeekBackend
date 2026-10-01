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

	@UseGuards(OwnsAppliedListingGuard)
	@LandlordAgency()
	@Patch(":id/approve")
	async approveApplication(@Param("id") id: string) {
		return await this.applicationService.approve(id);
	}

	@UseGuards(OwnsAppliedListingGuard)
	@LandlordAgency()
	@Patch(":id/reject")
	async rejectApplication(@Param("id") id: string) {
		return await this.applicationService.reject(id);
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
	@Get("listing/:id")
	async getAllForListing(@Param("id") listingId: string) {
		return this.applicationService.getAllByListing(listingId);
	}

	@ApiByConversation()
	@StudentOrLandlord()
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

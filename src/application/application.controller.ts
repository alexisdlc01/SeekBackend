import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { LandlordAgency, Student } from "../auth/decorators/role-auth.decorator";
import { Applicant } from "./decorators/applicant.decorator";
import { OwnsListing } from "../listings/decorators/owns-listing.decorator";
import { ApiCreateApplicationDocs, ApiGetAllMyApplicationsDocs, ApiGetApplicationById, ApiGetShareLink, ApiJoinApplication, ApiSendApplication } from "./swagger/application-swagger.decorator";
import { OwnsAppliedListingGuard } from "./guards/owns-applied-listing.guard";
import { ApplicationOwnerGuard } from "./guards/application-owner.guard";

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
		await this.applicationService.create(body.listingId, user);
	}

	@ApiJoinApplication()
	@Student()
	@Patch(":id/join")
	async joinApplication(@CurrentUser() user: User, @Param("id") id: string) {
		return this.applicationService.join(id, user._id.toString());
	}

	@ApiSendApplication()
	@Student()
	@UseGuards(ApplicationOwnerGuard)
	@Post(":id/send")
	async sendApplication(@Param("id") id: string) {
		return this.applicationService.send(id);
	}

	@LandlordAgency()
	@UseGuards(OwnsAppliedListingGuard)
	@Patch(":id/approve")
	async approveApplication(@Param("id") id: string) {
		this.applicationService.approve(id);
	}

	@LandlordAgency()
	@UseGuards(OwnsAppliedListingGuard)
	@Patch(":id/reject")
	async rejectApplication(@Param("id") id: string) {
		this.applicationService.reject(id);
	}

	@ApiJoinApplication()
	@Student()
	@UseGuards(ApplicationOwnerGuard)
	@Patch(":id/delete")
	async deleteApplication(@Param("id") id: string) {
		return this.applicationService.delete(id);
	}


	@LandlordAgency()
	@OwnsListing()
	@Get("listing/:id")
	async getAllForListing(@Param("id") listingId: string) {
		return this.applicationService.getAllByListing(listingId);
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

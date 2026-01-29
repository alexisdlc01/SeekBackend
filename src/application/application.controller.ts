import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { Student } from "../auth/decorators/role-auth.decorator";
import { Applicant } from "./decorators/applicant.decorator";
import { OwnsListing } from "../listings/decorators/owns-listing.decorator";
import { ApiCreateApplicationDocs, ApiGetAllMyApplicationsDocs, ApiGetApplicationById, ApiGetShareLink, ApiJoinApplication, ApiSendApplication } from "./swagger/application-swagger.decorator";

@Controller("application")
export class ApplicationController {
	constructor(private readonly applicationService: ApplicationService) { }

	@ApiCreateApplicationDocs()
	@Post("create")
	@Student()
	async createApplication(
		@CurrentUser() user: User,
		@Body() body: CreateApplicationDto
	) {
		await this.applicationService.createApplication(body.listingId, user);
	}

	@ApiGetAllMyApplicationsDocs()
	@Get("mine")
	@Student()
	async getAllMyApplications(@CurrentUser() user: User) {
		return this.applicationService.getAllMyApplications(
			user._id.toString()
		);
	}

	@ApiGetApplicationById()
	@Get(":id")
	@Applicant()
	async getApplication(@Param("id") id: string) {
		return this.applicationService.findApplicationById(id);
	}

	@ApiGetShareLink()
	@Get(":id/share")
	@Applicant()
	async getShareLink(@Param("id") id: string) {
		return this.applicationService.getShareLinkForApplication(id);
	}

	@ApiJoinApplication()
	@Post(":id/join")
	@Student()
	async joinApplication(@CurrentUser() user: User, @Param("id") id: string) {
		return this.applicationService.joinApplication(id, user._id.toString());
	}

	@ApiSendApplication()
	@Post(":id/send")
	@Applicant()
	async sendApplication(@Param("id") id: string) {
		return this.applicationService.sendApplication(id);
	}

	@Patch(":id/review")
	@OwnsListing()
	async reviewApplication(@Param("id") id: string) {

	}
}

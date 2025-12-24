import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { ApplicantGuard } from "./guards/applicant.guard";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { Student } from "../auth/decorators/role-auth.decorator";

@Controller("application")
export class ApplicationController {
	constructor(private readonly applicationService: ApplicationService) {}

	@Post()
	@Student()
	async createApplication(
		@CurrentUser() user: User,
		@Body() body: CreateApplicationDto
	) {
		await this.applicationService.createApplication(body.listingId, user);
	}

	@Get()
	@UseGuards(ApplicantGuard)
	async getApplication() {}
}

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { CreateApplicationDto } from "./dto/create-application.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { Student } from "../auth/decorators/role-auth.decorator";
import { Applicant } from "./decorators/applicant.decorator";

@Controller("application")
export class ApplicationController {
	constructor(private readonly applicationService: ApplicationService) {}

	@Post("create")
	@Student()
	async createApplication(
		@CurrentUser() user: User,
		@Body() body: CreateApplicationDto
	) {
		await this.applicationService.createApplication(body.listingId, user);
	}

	@Get("mine")
	@Student()
	async getAllMyApplications(@CurrentUser() user: User) {
		return this.applicationService.getAllMyApplications(
			user._id.toString()
		);
	}

	@Get(":id")
	@Applicant()
	async getApplication(@Param("id") id: string) {
		console.log(id);
	}
}

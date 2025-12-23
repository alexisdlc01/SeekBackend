import { Controller, Post } from "@nestjs/common";
import { ApplicationService } from "./application.service";

@Controller("application")
export class ApplicationController {
	constructor(private readonly applicationService: ApplicationService) {}

	@Post()
	async createApplication() {

	}
}

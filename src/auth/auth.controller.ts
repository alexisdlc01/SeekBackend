import { Controller, Post, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	@Post("/login")
	@UseGuards(LocalAuthGuard)
	async login(
		@CurrentUser() user: User,
		@Res({ passthrough: true }) response: Response
	) {
		await this.authService.login(user, response);
	}
}

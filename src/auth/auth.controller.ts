import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { AuthService } from "./auth.service";
import { JwtRefreshGuard } from "./guards/jwt-refresh.guard";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { CreateUserDto } from "../users/dtos/create-user.dto";
import { UsersService } from "../users/users.service";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "../users/dtos/user.dto";

@Controller("auth")
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly usersService: UsersService
	) {}

	@Post("/login")
	@UseGuards(LocalAuthGuard)
	async login(
		@CurrentUser() user: User,
		@Res({ passthrough: true }) response: Response
	) {
		await this.authService.login(user, response);
	}

	@Post("/signup")
	async signup(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Get("/currentUser")
	@UseGuards(JwtAuthGuard)
	@Serialize(UserDto)
	async currentUser(@CurrentUser() user: User) {
		return user;
	}

	@Post("/refresh")
	@UseGuards(JwtRefreshGuard)
	async refreshToken(
		@CurrentUser() user: User,
		@Res({ passthrough: true }) response: Response
	) {
		await this.authService.login(user, response);
	}

	@Post("logout")
	@UseGuards(JwtAuthGuard)
	async logout(
		@CurrentUser() user: User,
		@Res({ passthrough: true }) response: Response
	) {
		await this.authService.logout(user, response);
	}
}

import {
	Body,
	Controller,
	Get,
	Post,
	Req,
	Res,
	UseGuards
} from "@nestjs/common";
import { Response, Request } from "express";
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
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		switch (request.headers.platform) {
			case "mobile":
				return await this.authService.login(user, response, true);
			default:
				return await this.authService.login(user, response, false);
		}
	}

	@Post("/signup")
	async signup(
		@Body() body: CreateUserDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		let newUser = (await this.usersService.create(body)) as User;
		const isMobile = request.headers.platform === "mobile";
		await this.authService.login(newUser, response, isMobile);
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
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		return this.authService.login(user, response, isMobile);
	}

	@Post("logout")
	@UseGuards(JwtAuthGuard)
	async logout(
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		await this.authService.logout(user, response, isMobile);
	}
}

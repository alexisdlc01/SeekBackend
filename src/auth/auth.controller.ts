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
import { CreateUserDto } from "../users/dto/create-user.dto";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "../users/dto/user.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { UsersService } from "../users/users.service";
import { GoogleOauthGuard } from "./guards/google-oauth.guard";
import { ConfigService } from "@nestjs/config";
import { GoogleUserDto } from "./dto/google-user.dto";
import { Superuser } from "./decorators/role-auth.decorator";

@Controller("auth")
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly usersService: UsersService,
		private readonly configService: ConfigService
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
	async signup(@Body() body: CreateUserDto) {
		await this.authService.signup(body);
	}

	@Post("/verify-email")
	async verifyEmail(
		@Body() body: VerifyEmailDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		let user = (await this.usersService.getUser({
			_id: body.userId
		})) as User;
		user = await this.authService.verifyEmail(user, body.token);
		const isMobile = request.headers.platform === "mobile";
		return this.authService.login(user, response, isMobile);
	}

	@Post("/forgot-password")
	async forgotPassword(@Body() body: { email: string }) {
		await this.authService.resetPassword(body.email);
	}

	@Post("/confirmPasswordReset")
	async confirmPasswordReset(
		@Body() body: { userId: string; token: string; newPassword: string }
	) {
		await this.authService.confirmResetPassword(
			body.userId,
			body.token,
			body.newPassword
		);
	}

	@Get("/google")
	@UseGuards(GoogleOauthGuard)
	async googleAuth() {}

	@Get("/google/callback")
	@UseGuards(GoogleOauthGuard)
	async googleAuthCallback(
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const requestUser = request.user as GoogleUserDto;
		let savedUser: User;
		try {
			savedUser = await this.usersService.getUser({
				email: requestUser.email
			});
		} catch {
			savedUser = (await this.usersService.createGoogleUser({
				...(request.user as GoogleUserDto)
			})) as User;
		}

		const isMobile = request.headers.platform === "mobile";
		await this.authService.login(savedUser, response, isMobile);

		if (!isMobile) {
			const baseUrl = this.configService.getOrThrow("FRONTEND_URL");
			response.redirect(`${baseUrl}/`);
		}
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

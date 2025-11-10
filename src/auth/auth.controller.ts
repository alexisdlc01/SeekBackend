import {
	Body,
	Controller,
	Get,
	NotFoundException,
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
import { ConfirmPasswordResetDto } from "./dto/confirm-password-reset.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ApiBody, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ErrorDto } from "src/dto/errorDto.dto";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly usersService: UsersService,
		private readonly configService: ConfigService
	) { }

	@Post("/login")
	@UseGuards(LocalAuthGuard)
	@ApiResponse({
		status: 201,
		schema: {
			type: "object",
			properties: {
				access_token: {
					type: "string"
				},
				refresh_token: {
					type: "string"
				}
			}
		}
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	async login(
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		return await this.authService.login(user, response, isMobile);
	}

	@Post("/signup")
	@ApiBody({ type: CreateUserDto })
	@ApiResponse({ status: 201 })
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 409,
		type: ErrorDto
	})
	async signup(@Body() body: CreateUserDto) {
		await this.authService.signup(body);
	}

	@Post("/verify-email")
	@ApiBody({ type: VerifyEmailDto })
	@ApiResponse({
		status: 201,
		schema: {
			type: "object",
			properties: {
				access_token: {
					type: "string"
				},
				refresh_token: {
					type: "string"
				}
			}
		}
	})
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async verifyEmail(
		@Body() body: VerifyEmailDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		let user = (await this.usersService.getUser({
			_id: body.userId
		})) as User | null;
		if (!user) {
			throw new NotFoundException("User not found");
		}

		user = await this.authService.verifyEmail(user, body.token);
		const isMobile = request.headers.platform === "mobile";
		return this.authService.login(user, response, isMobile);
	}

	@Post("/forgot-password")
	@ApiBody({ type: ForgotPasswordDto })
	@ApiResponse({ status: 201 })
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async forgotPassword(@Body() body: ForgotPasswordDto) {
		await this.authService.resetPassword(body.email);
	}

	@Post("/confirmPasswordReset")
	@ApiBody({ type: ConfirmPasswordResetDto })
	@ApiResponse({ status: 201 })
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async confirmPasswordReset(@Body() body: ConfirmPasswordResetDto) {
		await this.authService.confirmResetPassword(
			body.userId,
			body.token,
			body.newPassword
		);
	}

	@Get("/google")
	@UseGuards(GoogleOauthGuard)
	@ApiResponse({ status: 200 })
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	async googleAuth() { }

	@Get("/google/callback")
	@UseGuards(GoogleOauthGuard)
	@ApiResponse({ status: 200 })
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
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

		if (!savedUser.isGoogle) {
			await this.usersService.updateUser(
				{ email: savedUser.email },
				{ isGoogle: true }
			);
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
	@ApiResponse({
		status: 200,
		type: UserDto
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	async currentUser(@CurrentUser() user: User) {
		return user;
	}

	@Post("/refresh")
	@UseGuards(JwtRefreshGuard)
	@ApiResponse({
		status: 201,
		type: UserDto
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
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
	@ApiResponse({ status: 201 })
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async logout(
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		await this.authService.logout(user, response, isMobile);
	}
}

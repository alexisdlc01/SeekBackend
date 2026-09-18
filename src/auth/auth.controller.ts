import {
	Body,
	Controller,
	Get,
	Patch,
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
import { GoogleOauthGuard } from "./guards/google-oauth.guard";
import { ConfigService } from "@nestjs/config";
import { GoogleUserDto } from "./dto/google-user.dto";
import { ConfirmPasswordResetDto } from "./dto/confirm-password-reset.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ApiTags } from "@nestjs/swagger";
import {
	ApiConfirmPasswordDocs,
	ApiCurrentUserDocs,
	ApiForgotPasswordDocs,
	ApiGoogleCallbackDocs,
	ApiGoogleDocs,
	ApiLoginDocs,
	ApiLogoutDocs,
	ApiRefreshDocs,
	ApiResendOtpDocs,
	ApiChangePasswordDocs,
	ApiSignupDocs,
	ApiVerifyEmailDocs
} from "./swagger/auth-swagger.decorator";
import { plainToInstance } from "class-transformer";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ResendOtpDto } from "./dto/resend-otp.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly configService: ConfigService
	) { }

	@Post("/login")
	@Throttle({ auth: { limit: 10, ttl: 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard, LocalAuthGuard)
	@ApiLoginDocs()
	async login(
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		return await this.authService.login(user, response, isMobile);
	}

	@Post("/signup")
	@Throttle({ auth: { limit: 5, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard)
	@ApiSignupDocs()
	async signup(
		@Body() body: CreateUserDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		const result = await this.authService.signup(body, isMobile);
		if (result.verificationRequired) {
			return result;
		}

		const tokens = await this.authService.login(
			result.user,
			response,
			isMobile
		);
		return tokens
			? { verificationRequired: false, ...tokens }
			: { verificationRequired: false };
	}

	@Post("/verify-email")
	@Throttle({ auth: { limit: 10, ttl: 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard)
	@ApiVerifyEmailDocs()
	async verifyEmail(
		@Body() body: VerifyEmailDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		const user = await this.authService.verifyEmail(body.userId, body.token, isMobile);
		return this.authService.login(user, response, isMobile);
	}

	@Patch("/resend-otp")
	@Throttle({ auth: { limit: 5, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard)
	@ApiResendOtpDocs()
	async resendOtp(@Body() body: ResendOtpDto) {
		return this.authService.resendOtp(body.userId);
	}

	@Post("/forgot-password")
	@Throttle({ auth: { limit: 5, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard)
	@ApiForgotPasswordDocs()
	async forgotPassword(
		@Body() body: ForgotPasswordDto,
		@Req() request: Request
	) {
		const isMobile = request.headers.platform === "mobile";
		return this.authService.resetPassword(body.email, isMobile);
	}

	@Post("/confirmPasswordReset")
	@Throttle({ auth: { limit: 10, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard)
	@ApiConfirmPasswordDocs()
	async confirmPasswordReset(
		@Body() body: ConfirmPasswordResetDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const result = await this.authService.confirmResetPassword(
			body.userId,
			body.token,
			body.newPassword
		);
		if (request.headers.platform !== "mobile") {
			this.authService.clearAuthCookies(response);
		}
		return result;
	}

	@Patch("/password")
	@UseGuards(JwtAuthGuard)
	@ApiChangePasswordDocs()
	async changePassword(
		@Body() body: ChangePasswordDto,
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const result = await this.authService.changePassword(user, body);
		if (request.headers.platform !== "mobile") {
			this.authService.clearAuthCookies(response);
		}
		return result;
	}

	@Get("/google")
	@UseGuards(GoogleOauthGuard)
	@ApiGoogleDocs()
	async googleAuth() { }

	@Get("/google/callback")
	@UseGuards(GoogleOauthGuard)
	@ApiGoogleCallbackDocs()
	async googleAuthCallback(
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const requestUser = request.user as GoogleUserDto;
		const isMobile = request.headers.platform === "mobile";

		const savedUser = await this.authService.createGoogleUser(requestUser);
		await this.authService.login(savedUser, response, isMobile);
		if (!isMobile) {
			const baseUrl = this.configService.getOrThrow("FRONTEND_URL");
			response.redirect(`${baseUrl}/`);
		}
	}

	@Get("/currentUser")
	@UseGuards(JwtAuthGuard)
	@Serialize(UserDto)
	@ApiCurrentUserDocs()
	async currentUser(@CurrentUser() user: User) {
		const instance = plainToInstance(UserDto, user, {
			excludeExtraneousValues: true,
		});
		return instance;
	}

	@Post("/refresh")
	@Throttle({ auth: { limit: 30, ttl: 60_000, blockDuration: 60_000 } })
	@UseGuards(ThrottlerGuard, JwtRefreshGuard)
	@ApiRefreshDocs()
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
	@ApiLogoutDocs()
	async logout(
		@CurrentUser() user: User,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const isMobile = request.headers.platform === "mobile";
		return this.authService.logout(user, response, isMobile);
	}
}

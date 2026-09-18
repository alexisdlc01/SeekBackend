import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	Injectable,
	UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Response } from "express";
import UsersService from "../users/users.service";
import { RefreshSession, User } from "../users/users.schema";
import { UsersRepository } from "../users/users.repository";
import { CreateUserDto } from "../users/dto/create-user.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { GoogleUserDto } from "./dto/google-user.dto";
import { MailService } from "./mail.service";
import { Role } from "./role.enum";
import { TokenPayload } from "./token-payload.interface";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GENERIC_RESET_RESPONSE =
	"If an account exists, a password reset link has been sent.";

export type AuthenticatedUser = User & {
	authSessionId?: string;
	refreshTokenHash?: string;
};

type SignupResult =
	| { verificationRequired: true; userId: string }
	| { verificationRequired: false; user: User };

@Injectable()
export class AuthService {
	constructor(
		private readonly usersRepo: UsersRepository,
		private readonly usersService: UsersService,
		private readonly configService: ConfigService,
		private readonly mailService: MailService,
		private readonly jwtService: JwtService
	) { }

	generateOtp() {
		return randomInt(10000, 100000).toString();
	}

	async signup(body: CreateUserDto, isMobile: boolean): Promise<SignupResult> {
		if (body.role !== undefined && body.role !== Role.STUDENT) {
			throw new ForbiddenException(
				"Public signup is only available for student accounts."
			);
		}

		const verificationRequired = this.isEmailVerificationEnabled();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.verificationTtlMs());
		const password = await hash(body.password, this.bcryptRounds());
		const createData: Pick<User, "email" | "name"> & Partial<User> = {
			name: body.name.trim(),
			email: this.normalizeEmail(body.email),
			password,
			role: Role.STUDENT,
			isVerified: !verificationRequired,
			profilePicUrl: body.imageUrl
		};

		let verificationSecret: string | undefined;
		if (verificationRequired) {
			verificationSecret = isMobile
				? this.generateOtp()
				: randomBytes(32).toString("hex");

			Object.assign(createData, {
				emailVerificationTokenExpires: expiresAt,
				emailVerificationAttempts: 0,
				emailVerificationLastSentAt: now,
				emailVerificationWindowStartedAt: now,
				emailVerificationSendCount: 1,
				...(isMobile
					? { otpVerificationCode: this.hashToken(verificationSecret) }
					: { emailVerificationToken: this.hashToken(verificationSecret) })
			});
		}

		const newUser = await this.usersRepo.create(createData);
		if (!newUser) {
			throw new BadRequestException("Unable to create user.");
		}

		if (!verificationRequired) {
			return { verificationRequired: false, user: newUser };
		}

		if (isMobile) {
			await this.mailService.sendOtpEmail(newUser.email, verificationSecret!);
		} else {
			await this.mailService.sendVerificationEmail(
				newUser.email,
				verificationSecret!,
				newUser._id.toString()
			);
		}

		return {
			verificationRequired: true,
			userId: newUser._id.toString()
		};
	}

	async login(user: AuthenticatedUser, response: Response, isMobile: boolean) {
		this.assertCanAuthenticate(user);

		const accessTokenTtl = this.accessTokenTtlMs();
		const refreshTokenTtl = this.refreshTokenTtlMs();
		const expiresAccessToken = new Date(Date.now() + accessTokenTtl);
		const expiresRefreshToken = new Date(Date.now() + refreshTokenTtl);
		const sessionId = user.authSessionId ?? randomBytes(16).toString("hex");
		const tokenPayload: TokenPayload = {
			userId: user._id.toString(),
			sessionId
		};

		const accessToken = this.jwtService.sign(tokenPayload, {
			secret: this.configService.getOrThrow("JWT_ACCESS_TOKEN_SECRET"),
			expiresIn: `${accessTokenTtl}ms`,
			jwtid: randomBytes(16).toString("hex")
		});
		const refreshToken = this.jwtService.sign(tokenPayload, {
			secret: this.configService.getOrThrow("JWT_REFRESH_TOKEN_SECRET"),
			expiresIn: `${refreshTokenTtl}ms`,
			jwtid: randomBytes(16).toString("hex")
		});
		const refreshTokenHash = this.hashToken(refreshToken);

		if (user.authSessionId) {
			if (!user.refreshTokenHash) {
				throw new UnauthorizedException("Refresh token is not valid.");
			}

			const rotated = await this.usersRepo.rotateRefreshSession(
				user._id.toString(),
				sessionId,
				user.refreshTokenHash,
				refreshTokenHash,
				expiresRefreshToken
			);
			if (!rotated) {
				throw new UnauthorizedException("Refresh token has already been used.");
			}
		} else {
			const session: RefreshSession = {
				sessionId,
				tokenHash: refreshTokenHash,
				expiresAt: expiresRefreshToken,
				createdAt: new Date(),
				lastUsedAt: new Date()
			};
			const stored = await this.usersRepo.addRefreshSession(
				user._id.toString(),
				session,
				this.maxRefreshSessions()
			);
			if (!stored) {
				throw new UnauthorizedException("Unable to create a session.");
			}
		}

		if (!isMobile) {
			this.setAuthCookies(
				response,
				accessToken,
				refreshToken,
				expiresAccessToken,
				expiresRefreshToken
			);
			return;
		}

		return {
			access_token: accessToken,
			refresh_token: refreshToken
		};
	}

	async verifyUser(email: string, password: string) {
		const user = await this.usersRepo.getUserByEmail(this.normalizeEmail(email));
		if (!user?.password) {
			throw new UnauthorizedException("Credentials are not valid.");
		}

		const authenticated = await compare(password, user.password);
		if (!authenticated) {
			throw new UnauthorizedException("Credentials are not valid.");
		}

		this.assertCanAuthenticate(user);
		return user;
	}

	async verifyUserRefreshToken(
		refreshToken: string | undefined,
		userId: string,
		sessionId: string | undefined
	) {
		if (!refreshToken || !sessionId) {
			throw new UnauthorizedException("Refresh token is not valid.");
		}

		const user = await this.usersRepo.getUserById(userId);
		const session = user?.refreshSessions?.find(
			candidate => candidate.sessionId === sessionId
		);
		if (
			!user ||
			!session ||
			session.expiresAt <= new Date() ||
			!this.tokensMatch(refreshToken, session.tokenHash)
		) {
			throw new UnauthorizedException("Refresh token is not valid.");
		}

		this.assertCanAuthenticate(user);
		return Object.assign(user, {
			authSessionId: sessionId,
			refreshTokenHash: session.tokenHash
		}) as AuthenticatedUser;
	}

	async verifyEmail(id: string, token: string, isMobile: boolean) {
		if (!this.isEmailVerificationEnabled()) {
			throw new BadRequestException("Email verification is currently disabled.");
		}

		const user = await this.usersRepo.getUserById(id);
		if (!user) {
			throw new BadRequestException("Invalid verification request.");
		}
		if (user.isVerified) {
			throw new BadRequestException("Email address is already verified.");
		}

		const storedToken = isMobile
			? user.otpVerificationCode
			: user.emailVerificationToken;
		if (
			!storedToken ||
			!user.emailVerificationTokenExpires ||
			user.emailVerificationTokenExpires <= new Date()
		) {
			throw new BadRequestException("Verification code is invalid or expired.");
		}

		const maximumAttempts = this.verificationMaxAttempts();
		if ((user.emailVerificationAttempts ?? 0) >= maximumAttempts) {
			throw new BadRequestException(
				"Too many verification attempts. Request a new code."
			);
		}

		if (!this.tokensMatch(token, storedToken)) {
			const attempts = (user.emailVerificationAttempts ?? 0) + 1;
			await this.usersService.updateUser(
				{ _id: user._id },
				attempts >= maximumAttempts
					? {
						$set: { emailVerificationAttempts: attempts },
						$unset: {
							emailVerificationToken: 1,
							otpVerificationCode: 1,
							emailVerificationTokenExpires: 1
						}
					}
					: { $set: { emailVerificationAttempts: attempts } }
			);
			throw new BadRequestException("Verification code is invalid or expired.");
		}

		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: {
					isVerified: true,
					emailVerificationAttempts: 0
				},
				$unset: {
					emailVerificationToken: 1,
					otpVerificationCode: 1,
					emailVerificationTokenExpires: 1,
					emailVerificationLastSentAt: 1,
					emailVerificationWindowStartedAt: 1,
					emailVerificationSendCount: 1
				}
			}
		);

		const verifiedUser = await this.usersRepo.getUserById(id);
		if (!verifiedUser) {
			throw new BadRequestException("Invalid verification request.");
		}
		return verifiedUser;
	}

	async resendOtp(userId: string) {
		if (!this.isEmailVerificationEnabled()) {
			throw new BadRequestException("Email verification is currently disabled.");
		}

		const user = await this.usersRepo.getUserById(userId);
		if (!user) {
			throw new BadRequestException("Invalid verification request.");
		}
		if (user.isVerified) {
			throw new BadRequestException("Email address is already verified.");
		}

		const now = new Date();
		const cooldownMs = this.otpResendCooldownMs();
		if (
			user.emailVerificationLastSentAt &&
			now.getTime() - user.emailVerificationLastSentAt.getTime() < cooldownMs
		) {
			throw new HttpException(
				"Please wait before requesting another verification code.",
				HttpStatus.TOO_MANY_REQUESTS
			);
		}

		const windowMs = this.otpRateWindowMs();
		const existingWindowIsActive = Boolean(
			user.emailVerificationWindowStartedAt &&
			now.getTime() - user.emailVerificationWindowStartedAt.getTime() < windowMs
		);
		const sendCount = existingWindowIsActive
			? (user.emailVerificationSendCount ?? 0)
			: 0;
		if (sendCount >= this.otpMaxSendsPerWindow()) {
			throw new HttpException(
				"Too many verification codes requested. Try again later.",
				HttpStatus.TOO_MANY_REQUESTS
			);
		}

		const otp = this.generateOtp();
		const expiresAt = new Date(now.getTime() + this.verificationTtlMs());
		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: {
					otpVerificationCode: this.hashToken(otp),
					emailVerificationTokenExpires: expiresAt,
					emailVerificationAttempts: 0,
					emailVerificationLastSentAt: now,
					emailVerificationWindowStartedAt: existingWindowIsActive
						? user.emailVerificationWindowStartedAt
						: now,
					emailVerificationSendCount: sendCount + 1
				},
				$unset: { emailVerificationToken: 1 }
			}
		);
		await this.mailService.sendOtpEmail(user.email, otp);

		return {
			message: "Verification code sent.",
			expiresInSeconds: Math.floor(this.verificationTtlMs() / 1000)
		};
	}

	async resetPassword(email: string, isMobile: boolean) {
		const response = { message: GENERIC_RESET_RESPONSE };
		const user = await this.usersRepo.getUserByEmail(this.normalizeEmail(email));
		if (!user || user.isGoogle || !user.password) {
			return response;
		}

		const now = new Date();
		const cooldownMs = this.passwordResetCooldownMs();
		if (
			user.resetPasswordLastSentAt &&
			now.getTime() - user.resetPasswordLastSentAt.getTime() < cooldownMs
		) {
			return response;
		}

		const windowMs = this.passwordResetRateWindowMs();
		const existingWindowIsActive = Boolean(
			user.resetPasswordWindowStartedAt &&
			now.getTime() - user.resetPasswordWindowStartedAt.getTime() < windowMs
		);
		const sendCount = existingWindowIsActive
			? (user.resetPasswordSendCount ?? 0)
			: 0;
		if (sendCount >= this.passwordResetMaxSendsPerWindow()) {
			return response;
		}

		const rawToken = randomBytes(32).toString("hex");
		const expires = new Date(now.getTime() + this.passwordResetTtlMs());
		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: {
					resetPasswordToken: this.hashToken(rawToken),
					resetPasswordExpires: expires,
					resetPasswordLastSentAt: now,
					resetPasswordWindowStartedAt: existingWindowIsActive
						? user.resetPasswordWindowStartedAt
						: now,
					resetPasswordSendCount: sendCount + 1
				}
			}
		);

		const baseUrl = isMobile
			? this.configService.get<string>("MOBILE_PASSWORD_RESET_URL") ??
				"seekapp://link/reset-password"
			: this.configService.get<string>("FRONTEND_PASSWORD_RESET_URL") ??
				`${this.configService.getOrThrow("FRONTEND_URL")}/confirmResetPassword`;
		const separator = baseUrl.includes("?") ? "&" : "?";
		const idParameter = isMobile ? "userId" : "id";
		const resetLink =
			`${baseUrl}${separator}token=${encodeURIComponent(rawToken)}` +
			`&${idParameter}=${encodeURIComponent(user._id.toString())}`;
		await this.mailService.sendResetPasswordEmail(user.email, resetLink);

		return response;
	}

	async confirmResetPassword(
		userId: string,
		token: string,
		newPassword: string
	) {
		const user = await this.usersRepo.getUserById(userId);
		if (
			!user?.resetPasswordToken ||
			!user.resetPasswordExpires ||
			user.resetPasswordExpires <= new Date() ||
			!this.tokensMatch(token, user.resetPasswordToken)
		) {
			throw new BadRequestException("Invalid or expired reset token.");
		}

		const passwordHash = await hash(newPassword, this.bcryptRounds());
		const consumed = await this.usersRepo.consumePasswordReset(
			userId,
			user.resetPasswordToken,
			passwordHash
		);
		if (!consumed) {
			throw new BadRequestException("Invalid or expired reset token.");
		}

		return { message: "Password successfully reset." };
	}

	async changePassword(user: User, body: ChangePasswordDto) {
		if (!user.password || !(await compare(body.currentPassword, user.password))) {
			throw new UnauthorizedException("Current password is not valid.");
		}
		if (await compare(body.newPassword, user.password)) {
			throw new BadRequestException(
				"New password must be different from the current password."
			);
		}

		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: {
					password: await hash(body.newPassword, this.bcryptRounds()),
					refreshSessions: []
				}
			}
		);
		return {
			message: "Password successfully changed. Please sign in again."
		};
	}

	async logout(user: AuthenticatedUser, response: Response, isMobile: boolean) {
		if (user.authSessionId) {
			await this.usersRepo.removeRefreshSession(
				user._id.toString(),
				user.authSessionId
			);
		} else {
			await this.usersRepo.clearRefreshSessions(user._id.toString());
		}

		if (!isMobile) {
			this.clearAuthCookies(response);
		}
		return { message: "Successfully logged out." };
	}

	async createGoogleUser(user: GoogleUserDto) {
		const email = this.normalizeEmail(user.email);
		let savedUser = await this.usersRepo.getUserByEmail(email);
		if (!savedUser) {
			savedUser = await this.usersRepo.createPaswordless({
				profilePicUrl: user.profilePicUrl,
				name: user.name,
				email,
				role: Role.STUDENT,
				isGoogle: true,
				isVerified: true
			});
		} else if (!savedUser.isGoogle) {
			await this.usersService.updateUser(
				{ _id: savedUser._id },
				{ $set: { isGoogle: true, isVerified: true } }
			);
			savedUser = await this.usersRepo.getUserById(savedUser._id.toString());
		}

		if (!savedUser) {
			throw new BadRequestException("Unable to create or find user.");
		}
		return savedUser;
	}

	clearAuthCookies(response: Response) {
		const options = this.cookieOptions();
		response.clearCookie("Authentication", { ...options, path: "/" });
		response.clearCookie("Refresh", { ...options, path: "/auth" });
	}

	private assertCanAuthenticate(user: User) {
		if (this.isEmailVerificationEnabled() && !user.isVerified) {
			throw new UnauthorizedException("Email verification is required.");
		}
	}

	private setAuthCookies(
		response: Response,
		accessToken: string,
		refreshToken: string,
		accessExpires: Date,
		refreshExpires: Date
	) {
		const options = this.cookieOptions();
		response.cookie("Authentication", accessToken, {
			...options,
			path: "/",
			expires: accessExpires
		});
		response.cookie("Refresh", refreshToken, {
			...options,
			path: "/auth",
			expires: refreshExpires
		});
	}

	private cookieOptions() {
		const production = this.configService.get("NODE_ENV") === "production";
		return {
			httpOnly: true,
			secure: production,
			sameSite: production ? "none" as const : "lax" as const
		};
	}

	private normalizeEmail(email: string) {
		return email.trim().toLowerCase();
	}

	private hashToken(token: string) {
		return createHash("sha256").update(token).digest("hex");
	}

	private tokensMatch(rawToken: string, expectedHash: string) {
		const actual = Buffer.from(this.hashToken(rawToken), "hex");
		const expected = Buffer.from(expectedHash, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	private isEmailVerificationEnabled() {
		return this.booleanConfig("AUTH_EMAIL_VERIFICATION_ENABLED", false);
	}

	private booleanConfig(key: string, fallback: boolean) {
		const value = this.configService.get<string | boolean>(key);
		if (value === undefined) return fallback;
		return value === true || value === "true";
	}

	private numericConfig(key: string, fallback: number, maximum?: number) {
		const value = Number(this.configService.get<string | number>(key) ?? fallback);
		if (!Number.isFinite(value) || value <= 0) return fallback;
		return Math.floor(maximum ? Math.min(value, maximum) : value);
	}

	private accessTokenTtlMs() {
		return this.numericConfig(
			"JWT_ACCESS_TOKEN_EXPIRATION_MS",
			ACCESS_TOKEN_TTL_MS,
			MAX_ACCESS_TOKEN_TTL_MS
		);
	}

	private refreshTokenTtlMs() {
		return this.numericConfig(
			"JWT_REFRESH_TOKEN_EXPIRATION_MS",
			REFRESH_TOKEN_TTL_MS,
			MAX_REFRESH_TOKEN_TTL_MS
		);
	}

	private maxRefreshSessions() {
		return this.numericConfig("AUTH_MAX_REFRESH_SESSIONS", 10, 20);
	}

	private bcryptRounds() {
		return this.numericConfig("AUTH_BCRYPT_ROUNDS", 12, 14);
	}

	private verificationTtlMs() {
		return this.numericConfig("AUTH_EMAIL_VERIFICATION_TTL_MS", 10 * 60 * 1000);
	}

	private verificationMaxAttempts() {
		return this.numericConfig("AUTH_EMAIL_VERIFICATION_MAX_ATTEMPTS", 5, 10);
	}

	private otpResendCooldownMs() {
		return this.numericConfig("AUTH_OTP_RESEND_COOLDOWN_MS", 60 * 1000);
	}

	private otpRateWindowMs() {
		return this.numericConfig("AUTH_OTP_RATE_WINDOW_MS", 60 * 60 * 1000);
	}

	private otpMaxSendsPerWindow() {
		return this.numericConfig("AUTH_OTP_MAX_SENDS_PER_WINDOW", 5, 10);
	}

	private passwordResetTtlMs() {
		return this.numericConfig("AUTH_PASSWORD_RESET_TTL_MS", 30 * 60 * 1000);
	}

	private passwordResetCooldownMs() {
		return this.numericConfig("AUTH_PASSWORD_RESET_COOLDOWN_MS", 60 * 1000);
	}

	private passwordResetRateWindowMs() {
		return this.numericConfig("AUTH_PASSWORD_RESET_RATE_WINDOW_MS", 60 * 60 * 1000);
	}

	private passwordResetMaxSendsPerWindow() {
		return this.numericConfig("AUTH_PASSWORD_RESET_MAX_SENDS_PER_WINDOW", 5, 10);
	}
}

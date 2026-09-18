import {
	BadRequestException,
	ForbiddenException,
	UnauthorizedException
} from "@nestjs/common";
import { hash } from "bcryptjs";
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { AuthenticatedUser, AuthService } from "./auth.service";
import { Role } from "./role.enum";
import { User } from "../users/users.schema";

const tokenHash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

describe("AuthService", () => {
	let service: AuthService;
	let usersRepo: Record<string, jest.Mock>;
	let usersService: Record<string, jest.Mock>;
	let mailService: Record<string, jest.Mock>;
	let jwtService: { sign: jest.Mock };
	let config: Record<string, string | number | boolean>;

	const makeUser = (overrides: Partial<User> = {}) => ({
		_id: new Types.ObjectId(),
		name: "Student",
		email: "student@example.com",
		password: "password-hash",
		role: Role.STUDENT,
		isVerified: true,
		isGoogle: false,
		refreshSessions: [],
		documents: [],
		emailVerificationAttempts: 0,
		emailVerificationSendCount: 0,
		resetPasswordSendCount: 0,
		...overrides
	}) as User;

	beforeEach(() => {
		config = {
			NODE_ENV: "test",
			JWT_ACCESS_TOKEN_SECRET: "access-secret",
			JWT_REFRESH_TOKEN_SECRET: "refresh-secret",
			JWT_ACCESS_TOKEN_EXPIRATION_MS: 36_000_000_000,
			JWT_REFRESH_TOKEN_EXPIRATION_MS: 604_800_000,
			AUTH_BCRYPT_ROUNDS: 4,
			FRONTEND_URL: "https://seek.example",
			MOBILE_PASSWORD_RESET_URL: "seekapp://link/reset-password"
		};
		usersRepo = {
			create: jest.fn(),
			createPaswordless: jest.fn(),
			getUserByEmail: jest.fn(),
			getUserById: jest.fn(),
			addRefreshSession: jest.fn().mockResolvedValue(true),
			rotateRefreshSession: jest.fn().mockResolvedValue(true),
			removeRefreshSession: jest.fn().mockResolvedValue(undefined),
			clearRefreshSessions: jest.fn().mockResolvedValue(undefined),
			consumePasswordReset: jest.fn().mockResolvedValue(true)
		};
		usersService = {
			updateUser: jest.fn().mockResolvedValue({})
		};
		mailService = {
			sendOtpEmail: jest.fn().mockResolvedValue(undefined),
			sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
			sendResetPasswordEmail: jest.fn().mockResolvedValue(undefined)
		};
		jwtService = {
			sign: jest.fn().mockImplementation((_payload, options) =>
				options.secret === "access-secret" ? "access-token" : "refresh-token"
			)
		};
		const configService = {
			get: jest.fn((key: string) => config[key]),
			getOrThrow: jest.fn((key: string) => {
				if (config[key] === undefined) throw new Error(`Missing ${key}`);
				return config[key];
			})
		};

		service = new AuthService(
			usersRepo as never,
			usersService as never,
			configService as never,
			mailService as never,
			jwtService as never
		);
	});

	it("creates only a normalized student account and skips verification by default", async () => {
		usersRepo.create.mockImplementation(async data => makeUser(data));

		const result = await service.signup({
			name: "  Ada  ",
			email: "  ADA@EXAMPLE.COM ",
			password: "Str0ng!Password"
		}, true);

		expect(result.verificationRequired).toBe(false);
		expect(usersRepo.create).toHaveBeenCalledWith(expect.objectContaining({
			name: "Ada",
			email: "ada@example.com",
			role: Role.STUDENT,
			isVerified: true
		}));
		expect(usersRepo.create.mock.calls[0][0].password).not.toBe("Str0ng!Password");
		expect(mailService.sendOtpEmail).not.toHaveBeenCalled();
	});

	it("rejects privileged roles on public signup", async () => {
		await expect(service.signup({
			name: "Agency",
			email: "agency@example.com",
			password: "Str0ng!Password",
			role: Role.LANDLORD_AGENCY
		}, false)).rejects.toBeInstanceOf(ForbiddenException);
		expect(usersRepo.create).not.toHaveBeenCalled();
	});

	it("stores a hashed five-digit OTP when verification is enabled", async () => {
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		jest.spyOn(service, "generateOtp").mockReturnValue("12345");
		usersRepo.create.mockImplementation(async data => makeUser(data));

		const result = await service.signup({
			name: "Ada",
			email: "ada@example.com",
			password: "Str0ng!Password"
		}, true);

		expect(result).toEqual({
			verificationRequired: true,
			userId: expect.any(String)
		});
		expect(usersRepo.create.mock.calls[0][0].otpVerificationCode)
			.toBe(tokenHash("12345"));
		expect(mailService.sendOtpEmail).toHaveBeenCalledWith(
			"ada@example.com",
			"12345"
		);
	});

	it("verifies the mobile OTP against the correct hashed field", async () => {
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		const pending = makeUser({
			isVerified: false,
			otpVerificationCode: tokenHash("12345"),
			emailVerificationToken: tokenHash("different-web-token"),
			emailVerificationTokenExpires: new Date(Date.now() + 60_000)
		});
		const verified = makeUser({ _id: pending._id, isVerified: true });
		usersRepo.getUserById
			.mockResolvedValueOnce(pending)
			.mockResolvedValueOnce(verified);

		await expect(service.verifyEmail(
			pending._id.toString(),
			"12345",
			true
		)).resolves.toBe(verified);
		expect(usersService.updateUser).toHaveBeenCalledWith(
			{ _id: pending._id },
			expect.objectContaining({
				$set: expect.objectContaining({ isVerified: true })
			})
		);
	});

	it("rejects an invalid OTP and records the failed attempt", async () => {
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		const pending = makeUser({
			isVerified: false,
			otpVerificationCode: tokenHash("12345"),
			emailVerificationTokenExpires: new Date(Date.now() + 60_000)
		});
		usersRepo.getUserById.mockResolvedValue(pending);

		await expect(service.verifyEmail(
			pending._id.toString(),
			"99999",
			true
		)).rejects.toBeInstanceOf(BadRequestException);
		expect(usersService.updateUser).toHaveBeenCalledWith(
			{ _id: pending._id },
			{ $set: { emailVerificationAttempts: 1 } }
		);
	});

	it("resends a fresh hashed OTP with a new expiry", async () => {
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		jest.spyOn(service, "generateOtp").mockReturnValue("54321");
		const pending = makeUser({
			isVerified: false,
			emailVerificationLastSentAt: new Date(Date.now() - 120_000),
			emailVerificationWindowStartedAt: new Date(Date.now() - 120_000),
			emailVerificationSendCount: 1
		});
		usersRepo.getUserById.mockResolvedValue(pending);

		await expect(service.resendOtp(pending._id.toString())).resolves.toEqual({
			message: "Verification code sent.",
			expiresInSeconds: 600
		});
		expect(usersService.updateUser).toHaveBeenCalledWith(
			{ _id: pending._id },
			expect.objectContaining({
				$set: expect.objectContaining({
					otpVerificationCode: tokenHash("54321"),
					emailVerificationTokenExpires: expect.any(Date),
					emailVerificationSendCount: 2
				})
			})
		);
		expect(mailService.sendOtpEmail).toHaveBeenCalledWith(
			pending.email,
			"54321"
		);
	});

	it("enforces the resend cooldown before issuing another OTP", async () => {
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		const pending = makeUser({
			isVerified: false,
			emailVerificationLastSentAt: new Date()
		});
		usersRepo.getUserById.mockResolvedValue(pending);

		await expect(service.resendOtp(pending._id.toString())).rejects
			.toMatchObject({ status: 429 });
		expect(mailService.sendOtpEmail).not.toHaveBeenCalled();
	});

	it("blocks login for an unverified account only when the flag is enabled", async () => {
		const password = await hash("Str0ng!Password", 4);
		usersRepo.getUserByEmail.mockResolvedValue(makeUser({
			password,
			isVerified: false
		}));

		await expect(service.verifyUser(
			"STUDENT@EXAMPLE.COM",
			"Str0ng!Password"
		)).resolves.toBeDefined();
		config.AUTH_EMAIL_VERIFICATION_ENABLED = true;
		await expect(service.verifyUser(
			"student@example.com",
			"Str0ng!Password"
		)).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it("creates a per-device session and caps an unsafe access-token lifetime", async () => {
		const user = makeUser();
		const tokens = await service.login(user, {} as never, true);

		expect(tokens).toEqual({
			access_token: "access-token",
			refresh_token: "refresh-token"
		});
		expect(jwtService.sign).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: user._id.toString(),
				sessionId: expect.any(String)
			}),
			expect.objectContaining({ expiresIn: "900000ms" })
		);
		expect(usersRepo.addRefreshSession).toHaveBeenCalledWith(
			user._id.toString(),
			expect.objectContaining({ tokenHash: tokenHash("refresh-token") }),
			10
		);
	});

	it("rotates only the refresh session that presented the token", async () => {
		const rawRefreshToken = "old-refresh-token";
		const session = {
			sessionId: "session-a",
			tokenHash: tokenHash(rawRefreshToken),
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			lastUsedAt: new Date()
		};
		const user = makeUser({ refreshSessions: [session] });
		usersRepo.getUserById.mockResolvedValue(user);

		const authenticated = await service.verifyUserRefreshToken(
			rawRefreshToken,
			user._id.toString(),
			session.sessionId
		);
		await service.login(authenticated, {} as never, true);

		expect(usersRepo.rotateRefreshSession).toHaveBeenCalledWith(
			user._id.toString(),
			"session-a",
			session.tokenHash,
			tokenHash("refresh-token"),
			expect.any(Date)
		);
		expect(usersRepo.addRefreshSession).not.toHaveBeenCalled();
	});

	it("rejects a refresh-token reuse when atomic rotation loses the race", async () => {
		usersRepo.rotateRefreshSession.mockResolvedValue(false);
		const user = Object.assign(makeUser(), {
			authSessionId: "session-a",
			refreshTokenHash: tokenHash("old-refresh-token")
		}) as AuthenticatedUser;

		await expect(service.login(user, {} as never, true)).rejects
			.toBeInstanceOf(UnauthorizedException);
	});

	it("returns the same forgot-password response for an unknown account", async () => {
		usersRepo.getUserByEmail.mockResolvedValue(null);

		await expect(service.resetPassword("missing@example.com", true)).resolves
			.toEqual({
				message: "If an account exists, a password reset link has been sent."
			});
		expect(mailService.sendResetPasswordEmail).not.toHaveBeenCalled();
	});

	it("stores a hashed reset token and sends a mobile deep link", async () => {
		const user = makeUser();
		usersRepo.getUserByEmail.mockResolvedValue(user);

		await service.resetPassword(user.email, true);

		const storedHash = usersService.updateUser.mock.calls[0][1].$set
			.resetPasswordToken;
		expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
		const link = mailService.sendResetPasswordEmail.mock.calls[0][1];
		expect(link).toContain("seekapp://link/reset-password?token=");
		expect(link).toContain(`&userId=${user._id.toString()}`);
		expect(link).not.toContain(storedHash);
	});

	it("atomically consumes a reset token and revokes all refresh sessions", async () => {
		const rawToken = "raw-reset-token";
		const user = makeUser({
			resetPasswordToken: tokenHash(rawToken),
			resetPasswordExpires: new Date(Date.now() + 60_000)
		});
		usersRepo.getUserById.mockResolvedValue(user);

		await expect(service.confirmResetPassword(
			user._id.toString(),
			rawToken,
			"An0ther!Password"
		)).resolves.toEqual({ message: "Password successfully reset." });
		expect(usersRepo.consumePasswordReset).toHaveBeenCalledWith(
			user._id.toString(),
			user.resetPasswordToken,
			expect.any(String)
		);
	});

	it("changes a password and clears every session", async () => {
		const user = makeUser({ password: await hash("Old!Password1", 4) });

		await service.changePassword(user, {
			currentPassword: "Old!Password1",
			newPassword: "New!Password2"
		});

		expect(usersService.updateUser).toHaveBeenCalledWith(
			{ _id: user._id },
			expect.objectContaining({
				$set: expect.objectContaining({ refreshSessions: [] })
			})
		);
	});

	it("logs out only the current device session", async () => {
		const user = Object.assign(makeUser(), {
			authSessionId: "session-a"
		}) as AuthenticatedUser;

		await service.logout(user, {} as never, true);

		expect(usersRepo.removeRefreshSession).toHaveBeenCalledWith(
			user._id.toString(),
			"session-a"
		);
		expect(usersRepo.clearRefreshSessions).not.toHaveBeenCalled();
	});
});

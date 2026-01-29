import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	UnauthorizedException
} from "@nestjs/common";
import UsersService from "../users/users.service";
import { compare, hash } from "bcryptjs";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { User } from "../users/users.schema";
import { Response } from "express";
import { TokenPayload } from "./token-payload.interface";
import { CreateUserDto } from "../users/dto/create-user.dto";
import { randomBytes } from "crypto";
import { addMinutes } from "date-fns";
import { MailService } from "./mail.service";
import { Role } from "./role.enum";
import { randomInt } from "node:crypto";
import { UsersRepository } from "src/users/users.repository";
import { UserDto } from "src/users/dto/user.dto";
import { GoogleUserDto } from "./dto/google-user.dto";
import { NotFoundError } from "rxjs";

@Injectable()
export class AuthService {
	constructor(
		private readonly usersRepo: UsersRepository,
		private readonly usersService: UsersService,
		private readonly configService: ConfigService,
		private readonly mailService: MailService,
		private readonly jwtService: JwtService
	) { }

	generateOtp = () => randomInt(10000, 100000).toString();

	async signup(body: CreateUserDto, isMobile: boolean) {
		if (body.role === Role.STUDENT || body.role === Role.LANDLORD_AGENCY) {
			const expires = addMinutes(new Date(), 60);

			if (isMobile) {
				const otp = this.generateOtp();

				const newUser = await this.usersRepo.create({
					...body,
					otpVerificationCode: otp,
					emailVerificationTokenExpires: expires
				});

				if (!newUser) {
					throw new BadRequestException("Unable to create user.");
				}

				await this.mailService.sendOtpEmail(newUser.email, otp);

				const expiresAccessToken = new Date();
				expiresAccessToken.setMilliseconds(
					expiresAccessToken.getTime() +
					parseInt(
						this.configService.getOrThrow<string>(
							"JWT_ACCESS_TOKEN_EXPIRATION_MS"
						)
					)
				);
				const tokenPayload: TokenPayload = {
					userId: newUser._id.toHexString()
				};

				const access_token = this.jwtService.sign(tokenPayload, {
					secret: this.configService.getOrThrow(
						"JWT_ACCESS_TOKEN_SECRET"
					),
					expiresIn: `${this.configService.getOrThrow("JWT_ACCESS_TOKEN_EXPIRATION_MS")}ms`
				});

				return {
					access_token,
					refresh_token: newUser.refreshToken
				};
			} else {
				const token = randomBytes(32).toString("hex");

				const newUser = await this.usersService.create({
					...body,
					emailVerificationToken: token,
					emailVerificationTokenExpires: expires
				});

				if (!newUser) {
					throw new BadRequestException("Unable to create user.");
				}

				await this.mailService.sendVerificationEmail(
					newUser.email,
					token,
					newUser._id.toString()
				);
			}
		}
	}

	async login(user: User, response: Response, isMobile: boolean) {
		const expiresAccessToken = new Date();
		expiresAccessToken.setMilliseconds(
			expiresAccessToken.getTime() +
			parseInt(
				this.configService.getOrThrow<string>(
					"JWT_ACCESS_TOKEN_EXPIRATION_MS"
				)
			)
		);

		const expiresRefreshToken = new Date();
		expiresRefreshToken.setMilliseconds(
			expiresRefreshToken.getTime() +
			parseInt(
				this.configService.getOrThrow<string>(
					"JWT_REFRESH_TOKEN_EXPIRATION_MS"
				)
			)
		);

		const tokenPayload: TokenPayload = {
			userId: user._id.toHexString()
		};

		const accessToken = this.jwtService.sign(tokenPayload, {
			secret: this.configService.getOrThrow("JWT_ACCESS_TOKEN_SECRET"),
			expiresIn: `${this.configService.getOrThrow("JWT_ACCESS_TOKEN_EXPIRATION_MS")}ms`
		});

		const refreshToken = this.jwtService.sign(tokenPayload, {
			secret: this.configService.getOrThrow("JWT_REFRESH_TOKEN_SECRET"),
			expiresIn: `${this.configService.getOrThrow("JWT_REFRESH_TOKEN_EXPIRATION_MS")}ms`
		});

		await this.usersService.updateUser(
			{
				_id: user._id
			},
			{ $set: { refreshToken: await hash(refreshToken, 10) } }
		);

		if (!isMobile) {
			response.cookie("Authentication", accessToken, {
				httpOnly: true,
				secure: this.configService.get("NODE_ENV") === "production",
				expires: expiresAccessToken,
				sameSite:
					this.configService.getOrThrow("NODE_ENV") === "production"
						? "none"
						: "lax"
			});

			response.cookie("Refresh", refreshToken, {
				httpOnly: true,
				secure: this.configService.get("NODE_ENV") === "production",
				expires: expiresRefreshToken,
				sameSite:
					this.configService.getOrThrow("NODE_ENV") === "production"
						? "none"
						: "lax"
			});
		} else {
			return {
				access_token: accessToken,
				refresh_token: refreshToken
			};
		}
	}

	async verifyUser(email: string, password: string) {
		const user = await this.usersRepo.getUserByEmail(email);
		if (!user) {
			throw new NotFoundException("User not found.");
		}

		try {
			const authenticated = await compare(password, user.password);
			if (!authenticated) {
				throw new UnauthorizedException();
			}
			return user;
		} catch (err) {
			throw new UnauthorizedException("Credentials are not valid.");
		}
	}

	async verifyUserRefreshToken(refreshToken: string, userId: string) {
		const user = await this.usersRepo.getUserById(userId);
		if (!user) {
			throw new NotFoundException("User not found.");
		}

		try {
			const [authenticated] = await Promise.all([
				compare(refreshToken, user.refreshToken as string)
			]);
			if (!authenticated) {
				throw new UnauthorizedException();
			}
			return user;
		} catch (err) {
			throw new UnauthorizedException("Refresh token is not valid.");
		}
	}

	async verifyEmail(id: string, token: string, isMobile: boolean) {
		const user = await this.usersRepo.getUserById(id);
		if (!user) {
			throw new NotFoundException("User not found.");
		}

		const expirationDate = user.emailVerificationTokenExpires as Date;
		const currentDate = new Date();
		if (expirationDate < currentDate) {
			throw new BadRequestException("This token has expired");
		}
		if (isMobile) {
			if (token === user.emailVerificationToken) {
				await this.usersService.updateUser(
					{
						_id: user._id
					},
					{
						$set: { isVerified: true },
						$unset: {
							emailVerificationToken: 1,
							emailVerificationTokenExpires: 1
						}
					}
				);
			}
		} else {
			if (token === user.otpVerificationCode) {
				await this.usersService.updateUser(
					{
						_id: user._id
					},
					{
						$set: { isVerified: true },
						$unset: {
							otpVerificationCode: 1,
							emailVerificationTokenExpires: 1
						}
					}
				);
			}
		}

		return user;
	}

	async resetPassword(email: string) {
		const user = await this.usersRepo.getUserByEmail(email);
		if (!user) {
			throw new NotFoundException("User not found");
		}

		if (user.isGoogle)
			throw new BadRequestException(
				"This account uses Google login. Please sign in with Google."
			);

		const rawToken = randomBytes(32).toString("hex");
		const hashedToken = await hash(rawToken, 10);

		const expires = addMinutes(new Date(), 5);

		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: {
					resetPasswordToken: hashedToken,
					resetPasswordExpires: expires
				}
			}
		);

		const resetLink = `${this.configService.getOrThrow("FRONTEND_URL")}/confirmResetPassword?token=${rawToken}&id=${user._id}`;
		await this.mailService.sendResetPasswordEmail(user.email, resetLink);

		return { message: "Password reset link sent." };
	}

	async confirmResetPassword(
		userId: string,
		token: string,
		newPassword: string
	) {
		const user = await this.usersRepo.getUserById(userId);

		if (!user) throw new NotFoundException("No user found with this id");
		if (!user.resetPasswordToken)
			throw new BadRequestException("Invalid or expired reset request");
		if (user.resetPasswordExpires && user.resetPasswordExpires < new Date())
			throw new BadRequestException("Invalid reset token");

		const isValid = await compare(token, user.resetPasswordToken);
		if (!isValid) throw new BadRequestException("Invalid reset token");

		const hashedPassword = await hash(newPassword, 10);

		await this.usersService.updateUser(
			{ _id: user._id },
			{
				$set: { password: hashedPassword },
				$unset: {
					resetPasswordToken: 1,
					resetPasswordExpires: 1
				}
			}
		);

		return { message: "Password successfully reset." };
	}

	async logout(user: User, response: Response, isMobile: boolean) {
		const update = await this.usersService.updateUser(
			{ _id: user._id },
			{ $unset: { refreshToken: 1 } }
		);
		if (!update) {
			throw new InternalServerErrorException("user not found post auth.");
		}

		if (!isMobile) {
			response.clearCookie("Authentication", {
				httpOnly: true,
				secure: this.configService.get("NODE_ENV") === "production",
				sameSite:
					this.configService.getOrThrow("NODE_ENV") === "production"
						? "none"
						: "lax"
			});
			response.clearCookie("Refresh", {
				httpOnly: true,
				secure: this.configService.get("NODE_ENV") === "production",
				sameSite:
					this.configService.getOrThrow("NODE_ENV") === "production"
						? "none"
						: "lax"
			});
		}
	}

	async createGoogleUser(user: GoogleUserDto) {
		let savedUser = await this.usersRepo.getUserByEmail(user.email);
		if (!savedUser) {
			savedUser = await this.usersRepo.createPaswordless({
				imageUrl: user.imageUrl,
				name: user.name,
				email: user.email,
				role: user.role,
			});
		}
		if (!savedUser) {
			throw new NotFoundException("Unable to create or find user.");
		}

		if (!savedUser.isGoogle) {
			await this.usersService.updateUser(
				{ email: savedUser.email },
				{ isGoogle: true }
			);
		}
		return savedUser;
	}
}

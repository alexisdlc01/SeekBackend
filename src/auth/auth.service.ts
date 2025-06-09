import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UsersService } from "../users/users.service";
import { compare, hash } from "bcryptjs";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { User } from "../users/users.schema";
import { Response } from "express";
import { TokenPayload } from "./token-payload.interface";

@Injectable()
export class AuthService {
	constructor(
		private readonly usersService: UsersService,
		private readonly configService: ConfigService,
		private readonly jwtService: JwtService
	) {}

	async login(user: User, response: Response) {
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

		response.cookie("Authentication", accessToken, {
			httpOnly: true,
			secure: this.configService.get("NODE_ENV") === "production",
			expires: expiresAccessToken
		});

		response.cookie("Refresh", refreshToken, {
			httpOnly: true,
			secure: this.configService.get("NODE_ENV") === "production",
			expires: expiresRefreshToken
		});
	}

	async verifyUser(email: string, password: string) {
		try {
			const user = await this.usersService.getUser({
				email
			});
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
		try {
			const user = await this.usersService.getUser({ _id: userId });
			const authenticated = compare(
				refreshToken,
				// @ts-ignore
				user.refreshToken
			);
			if (!authenticated) {
				throw new UnauthorizedException();
			}
			return user;
		} catch (err) {
			throw new UnauthorizedException("Refresh token is not valid.");
		}
	}

	async logout(user: User, response: Response) {
		await this.usersService.updateUser(
			{ _id: user._id },
			{ $unset: { refreshToken: 1 } }
		);

		response.clearCookie("Authentication", {
			httpOnly: true,
			secure: this.configService.get("NODE_ENV") === "production",
			sameSite: "strict"
		});
		response.clearCookie("Refresh", {
			httpOnly: true,
			secure: this.configService.get("NODE_ENV") === "production",
			sameSite: "strict"
		});
	}
}

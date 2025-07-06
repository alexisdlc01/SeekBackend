import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../../users/users.service";
import { Request } from "express";
import { TokenPayload } from "../token-payload.interface";
import { AuthService } from "../auth.service";

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
	Strategy,
	"jwt-refresh"
) {
	constructor(
		private readonly configService: ConfigService,
		private readonly usersService: UsersService,
		private readonly authService: AuthService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromExtractors([
				(req: Request) => {
					return req.headers.platform === "mobile"
						? req.body?.refreshToken
						: req.cookies?.Refresh;
				}
			]),
			secretOrKey: configService.getOrThrow("JWT_REFRESH_TOKEN_SECRET"),
			passReqToCallback: true
		});
	}

	async validate(req: Request, payload: TokenPayload) {
		return req.headers.platform === "mobile"
			? await this.authService.verifyUserRefreshToken(
					req.body?.refreshToken,
					payload.userId
				)
			: await this.authService.verifyUserRefreshToken(
					req.cookies?.Refresh,
					payload.userId
				);
	}
}

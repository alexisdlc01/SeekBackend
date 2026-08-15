import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
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
		private readonly authService: AuthService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromExtractors([
				(req: Request) => {
					if (!req) return null;

					const platform = req.headers["platform"];

					if (platform === "mobile") {
						const authHeader = req.headers["authorization"];
						if (authHeader && authHeader.startsWith("Bearer ")) {
							return authHeader.slice(7);
						}
					}

					return req.cookies?.Refresh || null;
				}
			]),
			secretOrKey: configService.getOrThrow("JWT_REFRESH_TOKEN_SECRET"),
			passReqToCallback: true
		});
	}

	async validate(req: Request, payload: TokenPayload) {
		const platform = req.headers["platform"];
		const token =
			platform === "mobile"
				? req.headers["authorization"]
						?.toString()
						.replace(/^Bearer\s/, "")
				: req.cookies?.Refresh;

		return this.authService.verifyUserRefreshToken(
			token,
			payload.userId,
			payload.sessionId
		);
	}
}

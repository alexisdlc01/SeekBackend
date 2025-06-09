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
		private readonly authServics: AuthService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromExtractors([
				(req: Request) => req.cookies?.Refresh
			]),
			secretOrKey: configService.getOrThrow("JWT_REFRESH_TOKEN_SECRET"),
			passReqToCallback: true
		});
	}

	async validate(req: Request, payload: TokenPayload) {
		return await this.authServics.verifyUserRefreshToken(
			req.cookies?.Refresh,
			payload.userId
		);
	}
}

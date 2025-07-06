import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { TokenPayload } from "../token-payload.interface";
import { UsersService } from "../../users/users.service";
import { Injectable } from "@nestjs/common";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private readonly configService: ConfigService,
		private readonly usersService: UsersService
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
					} else {
						return req.cookies?.Authentication || null;
					}
				}
			]),
			secretOrKey: configService.getOrThrow("JWT_ACCESS_TOKEN_SECRET")
		});
	}

	async validate(payload: TokenPayload) {
		return this.usersService.getUser({ _id: payload.userId });
	}
}

import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { TokenPayload } from "../token-payload.interface";
import UsersService from "../../users/users.service";
import { Injectable, NotFoundException } from "@nestjs/common";
import { User } from "src/users/users.schema";
import { UsersRepository } from "src/users/users.repository";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private readonly configService: ConfigService,
		private readonly usersRepo: UsersRepository
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
		const user = this.usersRepo.getUserById(payload.userId);
		if (!user) {
			throw new NotFoundException("User not found.");
		}
		return user;
	}
}

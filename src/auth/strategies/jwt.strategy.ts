import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { TokenPayload } from "../token-payload.interface";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UsersRepository } from "../../users/users.repository";
import type { AuthenticatedUser } from "../auth.service";

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
		const user = await this.usersRepo.getUserById(payload.userId);
		const session = user?.refreshSessions?.find(
			candidate => candidate.sessionId === payload.sessionId
		);
		const verificationEnabled =
			this.configService.get<string | boolean>(
				"AUTH_EMAIL_VERIFICATION_ENABLED"
			) === true ||
			this.configService.get<string | boolean>(
				"AUTH_EMAIL_VERIFICATION_ENABLED"
			) === "true";

		if (
			!user ||
			!payload.sessionId ||
			!session ||
			session.expiresAt <= new Date() ||
			(verificationEnabled && !user.isVerified)
		) {
			throw new UnauthorizedException("Session is not valid.");
		}

		return Object.assign(user, {
			authSessionId: payload.sessionId
		}) as AuthenticatedUser;
	}
}

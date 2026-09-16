import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from "@nestjs/common";
import { Socket } from "socket.io";
import { verify } from "jsonwebtoken";
import UsersService from "../../users/users.service";
import { TokenPayload } from "../token-payload.interface";

@Injectable()
export class WsJwtGuard implements CanActivate {
	constructor(private readonly usersService: UsersService) { }

	async canActivate(context: ExecutionContext): Promise<boolean> {
		// TODO: RBAC
		if (context.getType() !== "ws") {
			return false;
		}
		const client: Socket = context.switchToWs().getClient();
		return WsJwtGuard.validateToken(client, this.usersService);
	}

	static async validateToken(server: Socket, usersService: UsersService) {
		const token = this.extractToken(server);
		if (!token || !process.env.JWT_ACCESS_TOKEN_SECRET) {
			throw new UnauthorizedException("Invalid or missing token");
		}

		try {
			const payload = verify(
				token,
				process.env.JWT_ACCESS_TOKEN_SECRET
			) as TokenPayload;
			if (!payload.userId || !payload.sessionId) {
				throw new UnauthorizedException("Invalid or missing token");
			}

			const user = await usersService.getUserForSession(
				payload.userId,
				payload.sessionId
			);
			const verificationEnabled =
				process.env.AUTH_EMAIL_VERIFICATION_ENABLED === "true";
			if (verificationEnabled && !user.isVerified) {
				throw new UnauthorizedException("Email verification is required.");
			}
			server.data.user = user;
		} catch (err) {
			throw new UnauthorizedException("Session is not valid.");
		}
		return true;
	}

	static extractToken(socket: Socket): string | null {
		const platform = socket.handshake.headers?.platform as string;
		if (platform === "mobile") {
			const authHeader = socket.handshake.headers.authorization;

			if (authHeader?.startsWith("Bearer ")) {
				return authHeader.slice(7);
			}
			return (socket.handshake.query?.token as string) ?? null;
		}
		const cookieHeader = socket.handshake.headers.cookie;
		if (!cookieHeader) return null;

		const cookies = this.parseCookies(cookieHeader);
		return cookies["Authentication"] ?? null;
	}

	static parseCookies(cookieHeader: string): Record<string, string> {
		return cookieHeader
			.split(";")
			.map(cookie => cookie.trim().split("="))
			.reduce(
				(acc, [key, value]) => {
					acc[key] = decodeURIComponent(value);
					return acc;
				},
				{} as Record<string, string>
			);
	}
}

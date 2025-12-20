import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from "@nestjs/common";
import { Socket } from "socket.io";
import { verify } from "jsonwebtoken";
import { UsersService } from "../../users/users.service";
import { TokenPayload } from "../token-payload.interface";

@Injectable()
export class WsJwtGuard implements CanActivate {
	constructor(private readonly usersService: UsersService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		// TODO: RBAC
		if (context.getType() !== "ws") {
			return false;
		}
		const client: Socket = context.switchToWs().getClient();
		return WsJwtGuard.validateToken(client, this.usersService);
	}

	static async validateToken(server: Socket, usersService: UsersService) {
		const token = this.extractToken(server) as string;
		const payload = verify(
			token,
			process.env.JWT_ACCESS_TOKEN_SECRET as string
		) as TokenPayload;

		if (!payload)
			throw new UnauthorizedException("Invalid or missing token");

		const userId = payload.userId;
		try {
			const user = await usersService.getUser({ _id: userId });
			if (user) {
				server.data.user = user;
			}
		} catch (err) {
			throw new UnauthorizedException("User not found or deleted.");
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

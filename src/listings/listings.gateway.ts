import {
	OnGatewayInit,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Listing } from "./listings.schema";

@WebSocketGateway({
	cors: {
		origin: "http://localhost:5173",
		credentials: true
	}
})
export class ListingsGateway implements OnGatewayInit {
	@WebSocketServer()
	server: Server;

	constructor() {}

	afterInit(server: Server) {
		server.use(async (client: Socket, next) => {
			const token = this.extractToken(client);

		})
	}

	private extractToken(socket: Socket): string | null {
		const platform = socket.handshake.headers?.platform as string;
		if (platform === "mobile") {
			const authHeader = socket.handshake.headers.authorization;

			if (authHeader?.startsWith('Bearer ')) {
				return authHeader.slice(7);
			}
			return socket.handshake.query?.token as string ?? null;
		}
		const cookieHeader = socket.handshake.headers.cookie;
		if (!cookieHeader) return null;

		const cookies = this.parseCookies(cookieHeader);
		return cookies["Authentication"] ?? null;
	}

	private parseCookies(cookieHeader: string): Record<string, string> {
		return cookieHeader
			.split(";")
			.map((cookie) => cookie.trim().split("="))
			.reduce((acc, [key, value]) => {
				acc[key] = decodeURIComponent(value);
				return acc;
			}, {} as Record<string, string>);
	}

	emitListingUpdated(listing: Listing) {
		this.server.emit("listingUpdated", listing);
	}

	emitListingDeleted(listingId: string) {
		this.server.emit("listingDeleted", listingId);
	}

	emitListingCreated(listing: Listing) {
		this.server.emit("listingCreated", listing);
	}
}

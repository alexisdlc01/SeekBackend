import {
	OnGatewayConnection,
	OnGatewayDisconnect,
	OnGatewayInit,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Listing } from "./listings.schema";
import { ListingSocketPayload, ServerToClientEvents } from "./types/listings";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import UsersService from "../users/users.service";
import * as process from "node:process";
import { JwtPayload, verify } from "jsonwebtoken";
import { TokenPayload } from "../auth/token-payload.interface";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";

const SUPERUSER_ROOM = "listings:superusers";
const SESSION_REVALIDATION_INTERVAL_MS = 30_000;

export const landlordListingsRoom = (landlordId: string) =>
	`listings:landlord:${landlordId}`;

type ListingsSocketSession = TokenPayload & {
	exp: number;
	role: Role;
};

type SocketTimers = {
	expiration: ReturnType<typeof setTimeout>;
	revalidation: ReturnType<typeof setInterval>;
};

@WebSocketGateway({
	namespace: "listings",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
export class ListingsGateway
	implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
	@WebSocketServer()
	server: Server<any, ServerToClientEvents>;

	private readonly socketTimers = new Map<string, SocketTimers>();

	constructor(private readonly usersService: UsersService) {}

	afterInit(server: Server) {
		server.use(async (client, next) => {
			try {
				await WsJwtGuard.validateToken(client, this.usersService);
				const user = client.data?.user as User | undefined;
				if (!user || !this.isListingsRole(user.role)) {
					throw new Error("Role is not permitted");
				}

				const payload = this.verifiedTokenPayload(client);
				client.data.listingsSession = {
					...payload,
					role: user.role
				} satisfies ListingsSocketSession;
				next();
			} catch {
				next(new Error("Listings socket authentication failed."));
			}
		});
	}

	async handleConnection(client: Socket) {
		const user = client.data?.user as User | undefined;
		const session = client.data?.listingsSession as
			| ListingsSocketSession
			| undefined;
		if (!user?._id || !session || !this.isListingsRole(user.role)) {
			client.disconnect();
			return;
		}

		if (user.role === Role.SUPERUSER) {
			await client.join(SUPERUSER_ROOM);
		} else {
			await client.join(landlordListingsRoom(user._id.toString()));
		}

		this.scheduleSessionChecks(client, session);
	}

	handleDisconnect(client: Socket) {
		this.clearSessionChecks(client.id);
	}

	emitListingUpdated(listing: Listing) {
		this.server
			.to(this.audienceRooms(listing))
			.emit("listingUpdated", this.toSocketPayload(listing));
	}

	emitListingDeleted(listing: Listing) {
		this.server
			.to(this.audienceRooms(listing))
			.emit("listingDeleted", listing._id.toString());
	}

	emitListingCreated(listing: Listing) {
		this.server
			.to(this.audienceRooms(listing))
			.emit("listingCreated", this.toSocketPayload(listing));
	}

	private verifiedTokenPayload(
		client: Socket
	): TokenPayload & { exp: number } {
		const token = WsJwtGuard.extractToken(client);
		const secret = process.env.JWT_ACCESS_TOKEN_SECRET;
		if (!token || !secret) {
			throw new Error("Missing token");
		}

		const payload = verify(token, secret) as TokenPayload & JwtPayload;
		if (!payload.userId || !payload.sessionId || !payload.exp) {
			throw new Error("Invalid token payload");
		}
		return {
			userId: payload.userId,
			sessionId: payload.sessionId,
			exp: payload.exp
		};
	}

	private scheduleSessionChecks(
		client: Socket,
		session: ListingsSocketSession
	) {
		this.clearSessionChecks(client.id);
		const expiresInMs = session.exp * 1000 - Date.now();
		if (expiresInMs <= 0) {
			client.disconnect();
			return;
		}

		const expiration = setTimeout(() => client.disconnect(), expiresInMs);
		const revalidation = setInterval(() => {
			void this.revalidateClient(client);
		}, SESSION_REVALIDATION_INTERVAL_MS);
		expiration.unref?.();
		revalidation.unref?.();
		this.socketTimers.set(client.id, { expiration, revalidation });
	}

	private async revalidateClient(client: Socket) {
		if (client.connected === false) {
			this.clearSessionChecks(client.id);
			return;
		}

		const session = client.data?.listingsSession as
			| ListingsSocketSession
			| undefined;
		if (!session) {
			client.disconnect();
			return;
		}

		try {
			const user = await this.usersService.getUserForSession(
				session.userId,
				session.sessionId
			);
			if (!this.isListingsRole(user.role) || user.role !== session.role) {
				throw new Error("Role is no longer permitted");
			}
			client.data.user = user;
		} catch {
			this.clearSessionChecks(client.id);
			client.disconnect();
		}
	}

	private clearSessionChecks(socketId: string) {
		const timers = this.socketTimers.get(socketId);
		if (!timers) return;
		clearTimeout(timers.expiration);
		clearInterval(timers.revalidation);
		this.socketTimers.delete(socketId);
	}

	private audienceRooms(listing: Listing): string[] {
		const rooms = [landlordListingsRoom(listing.landlord.toString())];
		if (!listing.isDraft) {
			rooms.push(SUPERUSER_ROOM);
		}
		return rooms;
	}

	private toSocketPayload(listing: Listing): ListingSocketPayload {
		const document = listing as Listing & {
			toObject?: (
				options?: Record<string, unknown>
			) => Record<string, unknown>;
		};
		const raw = document.toObject
			? document.toObject({
					depopulate: true,
					virtuals: false,
					versionKey: false
				})
			: ({ ...listing } as Record<string, unknown>);
		const {
			registerOfTitleKey: _registerOfTitleKey,
			registrationNumber: _registrationNumber,
			likedBy: _likedBy,
			__v: _version,
			_id,
			landlord,
			...safeListing
		} = raw;

		return {
			...safeListing,
			_id: String(_id),
			landlord: String(landlord)
		} as ListingSocketPayload;
	}

	private isListingsRole(role: Role): boolean {
		return role === Role.LANDLORD_AGENCY || role === Role.SUPERUSER;
	}
}

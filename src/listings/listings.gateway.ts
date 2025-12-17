import {
	ConnectedSocket,
	OnGatewayInit,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Listing } from "./listings.schema";
import { ServerToClientEvents } from "./types/listings";
import { UseGuards } from "@nestjs/common";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import { SocketAuthMiddleware } from "../auth/middleware/ws.middleware";
import { UsersService } from "../users/users.service";
import * as process from "node:process";
import { ConnectedUser } from "../auth/decorators/connected-user.decorator";
import { User } from "../users/users.schema";

@WebSocketGateway({
	namespace: "listings",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class ListingsGateway implements OnGatewayInit {
	@WebSocketServer()
	server: Server<any, ServerToClientEvents>;

	constructor(private readonly usersService: UsersService) {}

	handleConnection(@ConnectedUser() user: User) {
		console.log(user);
	}

	afterInit(server: Server) {
		server.use(SocketAuthMiddleware(this.usersService));
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

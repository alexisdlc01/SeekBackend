import {
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server } from "socket.io";
import { Listing } from "./listings.schema";
import { ServerToClientEvents } from "./types/listings";
import { forwardRef, Inject, Logger, UseGuards } from "@nestjs/common";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import { ListingsService } from "./listings.service";
import { SocketAuthMiddleware } from "../auth/middleware/ws.middleware";
import { UsersService } from "../users/users.service";
import { ConnectedUser } from "../auth/decorators/connected-user.decorator";
import { User } from "../users/users.schema";

@WebSocketGateway({
	namespace: "listings",
	cors: {
		origin: "http://localhost:5173",
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class ListingsGateway implements OnGatewayInit {
	@WebSocketServer()
	server: Server<any, ServerToClientEvents>;

	constructor(
		@Inject(forwardRef(() => ListingsService))
		private readonly listingsService: ListingsService,
		private readonly usersService: UsersService
	) {}

	afterInit(server: Server): any {
		server.use(SocketAuthMiddleware(this.usersService));
	}

	@SubscribeMessage("createDraft")
	createDraft(@ConnectedUser() user: User, payload: any) {
		// TODO: get user
		// this.listingsService.createDraft()
		console.log("inside createDraft", user);
		return "hello world";
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

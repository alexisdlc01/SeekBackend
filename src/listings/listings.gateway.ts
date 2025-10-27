import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";
import { Listing } from "./listings.schema";
import { ServerToClientEvents } from "./types/listings";

@WebSocketGateway({
	namespace: "listings",
	cors: {
		origin: "http://localhost:5173",
		credentials: true
	}
})
export class ListingsGateway {
	@WebSocketServer()
	server: Server<any, ServerToClientEvents>;

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

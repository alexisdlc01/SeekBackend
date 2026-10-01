import {
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
	OnGatewayInit
} from "@nestjs/websockets";
import { UseGuards } from "@nestjs/common";
import { Server } from "socket.io";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import UsersService from "../users/users.service";
import { SocketAuthMiddleware } from "../auth/middleware/ws.middleware";

/**
 * Namespace scaffolding. It carries no real handlers yet, but it is
 * authenticated on the same terms as the other gateways so that whatever is
 * added here inherits a verified session rather than an open socket.
 */
@WebSocketGateway({
	namespace: "events",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class EventsGateway implements OnGatewayInit {
	@WebSocketServer()
	server: Server;

	constructor(private readonly usersService: UsersService) {}

	afterInit(server: Server) {
		server.use(SocketAuthMiddleware(this.usersService));
	}

	@SubscribeMessage("message")
	handleMessage(): string {
		return "Hello world!";
	}
}

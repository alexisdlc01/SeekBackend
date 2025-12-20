import { UseGuards } from "@nestjs/common";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import {
	OnGatewayConnection,
	OnGatewayDisconnect,
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { PresenceService } from "./presence.service";
import { UsersService } from "./users.service";
import { SocketAuthMiddleware } from "../auth/middleware/ws.middleware";
import { User } from "./users.schema";
import { ConnectedUser } from "../auth/decorators/connected-user.decorator";

@WebSocketGateway({
	namespace: "presence",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class PresenceGateway
	implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
	@WebSocketServer()
	server: Server;

	constructor(
		private readonly presenceService: PresenceService,
		private readonly usersService: UsersService
	) {}

	afterInit(server: Server) {
		server.use(SocketAuthMiddleware(this.usersService));
	}

	async handleConnection(client: Socket) {
		const user: User = client.data.user;

		const cameOnline = await this.presenceService.userConnected(
			user._id.toString()
		);

		if (cameOnline) {
			this.server.emit("presenceUpdate", {
				userId: user._id,
				online: true
			});
		}
	}

	async handleDisconnect(client: Socket) {
		const user: User = client.data.user;
		if (!user) return;

		const wentOffline = await this.presenceService.userDisconnected(
			user._id.toString()
		);

		if (wentOffline) {
			this.server.emit("presenceUpdate", {
				userId: user._id,
				online: false
			});

			await this.presenceService.updateLastSeen(user._id.toString());
		}
	}

	@SubscribeMessage("heartbeat")
	handleHeartbeat(@ConnectedUser() user: User) {
		return this.presenceService.heartbeat(user._id.toString());
	}
}

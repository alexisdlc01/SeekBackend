import {
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { UseGuards } from "@nestjs/common";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import { Server, Socket } from "socket.io";
import UsersService from "../users/users.service";
import { SocketAuthMiddleware } from "../auth/middleware/ws.middleware";
import { InjectModel } from "@nestjs/mongoose";
import { Message } from "./message.schema";
import { Model } from "mongoose";
import { MessageDto } from "src/message/dto/message.dto";

@WebSocketGateway({
	namespace: "conversation",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class ConversationGateway implements OnGatewayInit {
	@WebSocketServer()
	server: Server<any, any>;

	constructor(
		private readonly usersService: UsersService,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
	) { }

	afterInit(server: Server) {
		server.use(SocketAuthMiddleware(this.usersService));
	}

	@SubscribeMessage("conversation:join")
	joinConversation(client: Socket, conversationId: string) {
		client.join(conversationId);
	}

	emitNewMessage(conversationId: string, message: MessageDto) {
		this.server.to(conversationId).emit("message:new", message);
	}

	emitSeen(conversationId: string, userId: string) {
		this.server.to(conversationId).emit("conversation:seen", { userId });
	}

	@SubscribeMessage("message:delivered")
	async markDelivered(client: Socket, messageId: string) {
		await this.messageModel.updateOne(
			{ _id: messageId },
			// @ts-ignore
			{ $addToSet: { deliveredTo: client.userId } }
		);
	}

	@SubscribeMessage("conversation:seen")
	async markSeen(client: Socket, conversationId: string) {
		await this.messageModel.updateMany(
			{ conversation: conversationId },
			// @ts-ignore
			{ $addToSet: { seenUsers: client.userId } }
		);

		// @ts-ignore
		this.emitSeen(conversationId, client.userId);
	}
}

import {
	OnGatewayConnection,
	OnGatewayDisconnect,
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import {
	BadRequestException,
	NotFoundException,
	UnauthorizedException,
	UseGuards,
} from "@nestjs/common";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import { Server, Socket } from "socket.io";
import UsersService from "../users/users.service";
import { InjectModel } from "@nestjs/mongoose";
import { Message } from "./message.schema";
import { Model, Types } from "mongoose";
import { MessageDto } from "../message/dto/message.dto";
import { ConversationAccessService } from "./conversation-access.service";
import { User } from "../users/users.schema";
import { JwtPayload, verify } from "jsonwebtoken";
import { TokenPayload } from "../auth/token-payload.interface";

const SESSION_REVALIDATION_INTERVAL_MS = 30_000;

type ConversationSocketSession = TokenPayload & { exp: number };

type SocketTimers = {
	expiration: ReturnType<typeof setTimeout>;
	revalidation: ReturnType<typeof setInterval>;
};

type SessionSocket = {
	id: string;
	data: {
		user?: User;
		conversationSession?: ConversationSocketSession;
	};
	connected?: boolean;
	disconnect(close?: boolean): unknown;
};

@WebSocketGateway({
	namespace: "conversation",
	cors: {
		origin: process.env.FRONTEND_URL,
		credentials: true
	}
})
@UseGuards(WsJwtGuard)
export class ConversationGateway
	implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
	@WebSocketServer()
	server: Server<any, any>;
	private readonly socketTimers = new Map<string, SocketTimers>();

	constructor(
		private readonly usersService: UsersService,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
		private readonly conversationAccessService: ConversationAccessService,
	) { }

	afterInit(server: Server) {
		server.use(async (client, next) => {
			try {
				await WsJwtGuard.validateToken(client, this.usersService);
				client.data.conversationSession = this.verifiedTokenPayload(client);
				next();
			} catch {
				next(new Error("Conversation socket authentication failed."));
			}
		});
	}

	handleConnection(client: Socket) {
		const session = client.data?.conversationSession as
			| ConversationSocketSession
			| undefined;
		if (!client.data?.user || !session) {
			client.disconnect(true);
			return;
		}
		this.scheduleSessionChecks(client, session);
	}

	handleDisconnect(client: Socket) {
		this.clearSessionChecks(client.id);
	}

	@SubscribeMessage("conversation:join")
	async joinConversation(client: Socket, conversationId: string) {
		await this.conversationAccessService.assertCanAccess(
			conversationId,
			this.authenticatedUserId(client),
		);
		await client.join(conversationId);
	}

	async emitNewMessage(conversationId: string, message: MessageDto) {
		const recipients = await this.authorizedRecipients(conversationId);
		if (recipients.length > 0) {
			this.server.to(recipients).emit("message:new", message);
		}
	}

	async emitSeen(conversationId: string, userId: string) {
		const recipients = await this.authorizedRecipients(conversationId);
		if (recipients.length > 0) {
			this.server.to(recipients).emit("conversation:seen", { userId });
		}
	}

	@SubscribeMessage("message:delivered")
	async markDelivered(client: Socket, messageId: string) {
		if (!Types.ObjectId.isValid(messageId)) {
			throw new BadRequestException("Invalid message ID");
		}
		const message = await this.messageModel
			.findById(messageId)
			.select("conversation")
			.lean()
			.exec();
		if (!message) {
			throw new NotFoundException("Message not found");
		}
		const userId = this.authenticatedUserId(client);
		await this.conversationAccessService.assertCanAccess(
			message.conversation.toString(),
			userId,
		);
		await this.messageModel.updateOne(
			{ _id: messageId },
			{ $addToSet: { deliveredTo: new Types.ObjectId(userId) } }
		);
	}

	@SubscribeMessage("conversation:seen")
	async markSeen(client: Socket, conversationId: string) {
		const userId = this.authenticatedUserId(client);
		await this.conversationAccessService.assertCanAccess(
			conversationId,
			userId,
		);
		await this.messageModel.updateMany(
			{ conversation: conversationId },
			{ $addToSet: { seenUsers: new Types.ObjectId(userId) } }
		);

		await this.emitSeen(conversationId, userId);
	}

	private authenticatedUserId(client: Socket): string {
		const user = client.data?.user as User | undefined;
		if (!user?._id) {
			throw new UnauthorizedException("User is not authenticated");
		}
		return user._id.toString();
	}

	private verifiedTokenPayload(client: Socket): ConversationSocketSession {
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
			exp: payload.exp,
		};
	}

	private scheduleSessionChecks(
		client: Socket,
		session: ConversationSocketSession,
	) {
		this.clearSessionChecks(client.id);
		const expiresInMs = session.exp * 1000 - Date.now();
		if (expiresInMs <= 0) {
			client.disconnect(true);
			return;
		}

		const expiration = setTimeout(
			() => client.disconnect(true),
			expiresInMs,
		);
		const revalidation = setInterval(() => {
			void this.revalidateSession(client);
		}, SESSION_REVALIDATION_INTERVAL_MS);
		expiration.unref?.();
		revalidation.unref?.();
		this.socketTimers.set(client.id, { expiration, revalidation });
	}

	private async authorizedRecipients(conversationId: string): Promise<string[]> {
		const clients = await this.server.in(conversationId).fetchSockets();
		const recipients = await Promise.all(clients.map(async client => {
			if (!await this.revalidateSession(client)) return null;
			const session = client.data.conversationSession as ConversationSocketSession;
			try {
				await this.conversationAccessService.assertCanAccess(
					conversationId,
					session.userId,
				);
				return client.id;
			} catch {
				client.disconnect(true);
				return null;
			}
		}));
		return recipients.filter((id): id is string => id !== null);
	}

	private async revalidateSession(client: SessionSocket): Promise<boolean> {
		if (client.connected === false) {
			this.clearSessionChecks(client.id);
			return false;
		}
		const session = client.data?.conversationSession;
		if (!session || session.exp * 1000 <= Date.now()) {
			this.clearSessionChecks(client.id);
			client.disconnect(true);
			return false;
		}

		try {
			client.data.user = await this.usersService.getUserForSession(
				session.userId,
				session.sessionId,
			);
			return true;
		} catch {
			this.clearSessionChecks(client.id);
			client.disconnect(true);
			return false;
		}
	}

	private clearSessionChecks(socketId: string) {
		const timers = this.socketTimers.get(socketId);
		if (!timers) return;
		clearTimeout(timers.expiration);
		clearInterval(timers.revalidation);
		this.socketTimers.delete(socketId);
	}
}

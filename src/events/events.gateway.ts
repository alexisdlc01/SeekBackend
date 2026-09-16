import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { InjectModel } from "@nestjs/mongoose";
import Redis from "ioredis";

@WebSocketGateway({ namespace: "events" })
export class EventsGateway {
	@WebSocketServer()
	server: Server;

	// constructor(@InjectModel("REDIS_CLIENT") private readonly redis: Redis) {}

	@SubscribeMessage("message")
	handleMessage(client: any, payload: any): string {
		return "Hello world!";
	}

	// Need user's id
	// @SubscribeMessage("typing")
	// handleTyping(
	// 	@ConnectedSocket() client: Socket,
	// 	@MessageBody() payload: { isTyping: boolean }
	// ) {
	//
	// }
}

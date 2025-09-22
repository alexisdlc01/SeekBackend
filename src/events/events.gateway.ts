import {
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer
} from "@nestjs/websockets";
import { Server } from "socket.io";

@WebSocketGateway({ namespace: "events" })
export class EventsGateway {
	@WebSocketServer()
	server: Server;

	@SubscribeMessage("message")
	handleMessage(client: any, payload: any): string {
		console.log(client);
		console.log(payload);
		return "Hello world!";
	}
}

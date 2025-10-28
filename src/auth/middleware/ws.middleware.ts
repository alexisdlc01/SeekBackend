import { Socket } from "socket.io";
import { WsJwtGuard } from "../guards/ws-jwt.guard";
import {UsersService} from "../../users/users.service";

export type SocketIOMiddleware = {
	(server: Socket, next: (err?: Error) => void);
};

export const SocketAuthMiddleware = (usersService: UsersService): SocketIOMiddleware => {
	return (server, next) => {
		try {
			WsJwtGuard.validateToken(server, usersService);
		} catch (err) {
			next(err);
		}
		next();
	};
};

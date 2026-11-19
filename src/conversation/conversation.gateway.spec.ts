import { ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { ConversationGateway } from "./conversation.gateway";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard";
import { Role } from "../auth/role.enum";
import { TeamScope } from "../users/types/team-scope";

describe("ConversationGateway authorization", () => {
	const conversationId = new Types.ObjectId();
	const userId = new Types.ObjectId();
	let messageModel: {
		findById: jest.Mock;
		updateOne: jest.Mock;
		updateMany: jest.Mock;
	};
	let usersService: { getUserForSession: jest.Mock };
	let access: { assertCanAccess: jest.Mock };
	let usersRepository: { findTeamOwner: jest.Mock };
	let gateway: ConversationGateway;
	let client: {
		data: { user: { _id: Types.ObjectId } };
		join: jest.Mock;
	};

	beforeEach(() => {
		usersService = {
			getUserForSession: jest.fn().mockResolvedValue({ _id: userId }),
		};
		messageModel = {
			findById: jest.fn(),
			updateOne: jest.fn().mockResolvedValue(undefined),
			updateMany: jest.fn().mockResolvedValue(undefined),
		};
		access = { assertCanAccess: jest.fn().mockResolvedValue(undefined) };
		usersRepository = { findTeamOwner: jest.fn().mockResolvedValue(null) };
		gateway = new ConversationGateway(
			usersService as never,
			messageModel as never,
			access as never,
			usersRepository as never,
		);
		client = {
			data: { user: { _id: userId } },
			join: jest.fn().mockResolvedValue(undefined),
		};
	});

	it("joins an authorized member to the requested room", async () => {
		await gateway.joinConversation(
			client as never,
			conversationId.toString(),
		);

		expect(access.assertCanAccess).toHaveBeenCalledWith(
			conversationId.toString(),
			userId.toString(),
		);
		expect(client.join).toHaveBeenCalledWith(conversationId.toString());
	});

	it("lets a team member with inbox access act as the owner, and one without act as themselves", async () => {
		const ownerId = new Types.ObjectId();
		const member = { _id: userId, role: Role.LANDLORD_AGENCY };
		let middleware!: (socket: unknown, next: (error?: Error) => void) => Promise<void>;
		gateway.afterInit({ use: (fn: typeof middleware) => { middleware = fn; } } as never);
		const validate = jest.spyOn(WsJwtGuard, "validateToken").mockImplementation(async (socket: any) => {
			socket.data.user = member;
			return true;
		});
		jest.spyOn(gateway as any, "verifiedTokenPayload").mockReturnValue({ userId: userId.toString(), sessionId: "s", exp: 9e9 });

		for (const [scopes, actor] of [[[TeamScope.VIEWINGS_INBOX], ownerId], [[TeamScope.LISTINGS], userId]] as const) {
			usersRepository.findTeamOwner.mockResolvedValue({ owner: { _id: ownerId }, scopes });
			const socket = { data: {} as Record<string, unknown>, join: jest.fn() };
			const next = jest.fn();
			await middleware(socket, next);
			expect(next).toHaveBeenCalledWith();
			await gateway.joinConversation(socket as never, conversationId.toString());
			await gateway.markSeen(socket as never, conversationId.toString()).catch(() => undefined);
			expect(access.assertCanAccess).toHaveBeenLastCalledWith(conversationId.toString(), actor.toString());
			expect(messageModel.updateMany).toHaveBeenLastCalledWith(
				{ conversation: conversationId.toString() },
				{ $addToSet: { seenUsers: actor } }
			);
		}
		validate.mockRestore();
	});

	it("does not join an outsider to the room", async () => {
		access.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(gateway.joinConversation(
			client as never,
			conversationId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(client.join).not.toHaveBeenCalled();
	});

	it("does not mark a conversation seen for an outsider", async () => {
		access.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(gateway.markSeen(
			client as never,
			conversationId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(messageModel.updateMany).not.toHaveBeenCalled();
	});

	it("does not mark a message delivered for an outsider", async () => {
		const messageId = new Types.ObjectId();
		messageModel.findById.mockReturnValue({
			select: jest.fn().mockReturnValue({
				lean: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue({
						conversation: conversationId,
					}),
				}),
			}),
		});
		access.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(gateway.markDelivered(
			client as never,
			messageId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(messageModel.updateOne).not.toHaveBeenCalled();
	});

	it("disconnects a revoked recipient instead of broadcasting to it", async () => {
		const disconnect = jest.fn();
		const recipient = {
			id: "revoked-socket",
			connected: true,
			data: {
				conversationSession: {
					userId: userId.toString(),
					sessionId: "revoked-session",
					exp: Math.floor(Date.now() / 1000) + 60,
				},
			},
			disconnect,
		};
		const to = jest.fn();
		gateway.server = {
			in: jest.fn().mockReturnValue({
				fetchSockets: jest.fn().mockResolvedValue([recipient]),
			}),
			to,
		} as never;
		usersService.getUserForSession.mockRejectedValue(
			new Error("Session not found"),
		);

		await gateway.emitNewMessage(
			conversationId.toString(),
			{ data: "Private message" } as never,
		);

		expect(disconnect).toHaveBeenCalledWith(true);
		expect(to).not.toHaveBeenCalled();
	});

	it("broadcasts only to recipients with a live authorized session", async () => {
		const recipient = {
			id: "authorized-socket",
			connected: true,
			data: {
				conversationSession: {
					userId: userId.toString(),
					sessionId: "live-session",
					exp: Math.floor(Date.now() / 1000) + 60,
				},
			},
			disconnect: jest.fn(),
		};
		const emit = jest.fn();
		const to = jest.fn().mockReturnValue({ emit });
		gateway.server = {
			in: jest.fn().mockReturnValue({
				fetchSockets: jest.fn().mockResolvedValue([recipient]),
			}),
			to,
		} as never;
		const message = { data: "Private message" } as never;

		await gateway.emitNewMessage(conversationId.toString(), message);

		expect(usersService.getUserForSession).toHaveBeenCalledWith(
			userId.toString(),
			"live-session",
		);
		expect(access.assertCanAccess).toHaveBeenCalledWith(
			conversationId.toString(),
			userId.toString(),
		);
		expect(to).toHaveBeenCalledWith(["authorized-socket"]);
		expect(emit).toHaveBeenCalledWith("message:new", message);
	});
});

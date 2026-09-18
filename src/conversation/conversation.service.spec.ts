import { Types } from "mongoose";
import { ConversationService } from "./conversation.service";

// Mimics a populated mongoose document: toObject() returns the plain shape,
// including populated sub-documents with fields that must not leak.
const doc = (plain: any) => ({ ...plain, toObject: () => plain });

describe("ConversationService.getAllForUser", () => {
	const me = new Types.ObjectId();
	const other = new Types.ObjectId();
	const convA = new Types.ObjectId();
	const convB = new Types.ObjectId();

	const otherUser = {
		_id: other,
		name: "Alice",
		email: "alice@example.com",
		role: "STUDENT",
		password: "$2a$10$hashedsecret",
		refreshToken: "should-not-leak"
	};

	const conversations = [
		doc({
			_id: convA,
			name: "Older",
			createdAt: new Date("2026-01-01T00:00:00Z"),
			groupDescription: "",
			users: [{ _id: me, name: "Me", email: "me@example.com" }, otherUser],
			lastMessage: {
				_id: new Types.ObjectId(),
				sender: otherUser,
				messageType: "Text",
				data: "hello",
				createdAt: new Date("2026-01-02T00:00:00Z"),
				conversation: convA,
				seenUsers: [],
				deliveredTo: []
			}
		}),
		doc({
			_id: convB,
			name: "Newer",
			createdAt: new Date("2026-03-01T00:00:00Z"),
			groupDescription: "",
			users: [{ _id: me, name: "Me", email: "me@example.com" }]
		})
	];

	const conversationModel = {
		find: jest.fn().mockReturnValue({
			populate: jest.fn().mockReturnThis(),
			exec: jest.fn().mockResolvedValue(conversations)
		})
	};
	const messageModel = {
		aggregate: jest.fn().mockResolvedValue([{ _id: convA, count: 3 }])
	};

	const service = new ConversationService(
		conversationModel as any,
		messageModel as any,
		{} as any
	);

	it("returns the user's conversations with unread counts, newest first", async () => {
		const result = await service.getAllForUser(me.toHexString());

		expect(conversationModel.find).toHaveBeenCalledWith({ users: me });
		expect(result.map(c => c.name)).toEqual(["Newer", "Older"]);
		expect(result.find(c => c.name === "Older")!.unreadCount).toBe(3);
		expect(result.find(c => c.name === "Newer")!.unreadCount).toBe(0);
		expect(result.every(c => Array.isArray(c.messages))).toBe(true);
	});

	it("only counts unseen messages sent by other people", async () => {
		await service.getAllForUser(me.toHexString());

		const [pipeline] = messageModel.aggregate.mock.calls[0];
		expect(pipeline[0].$match).toEqual({
			conversation: { $in: [convA, convB] },
			sender: { $ne: me },
			seenUsers: { $ne: me }
		});
	});

	it("strips sensitive user fields from populated members and lastMessage sender", async () => {
		const [, older] = await service.getAllForUser(me.toHexString());

		const member = older.users.find(u => u.name === "Alice") as any;
		expect(member._id).toBe(other.toHexString());
		expect(member.password).toBeUndefined();
		expect(member.refreshToken).toBeUndefined();

		const sender = older.lastMessage!.sender as any;
		expect(sender.name).toBe("Alice");
		expect(sender.password).toBeUndefined();
		expect(sender.refreshToken).toBeUndefined();
	});

	it("serialises message ObjectId references as the same hex ids", async () => {
		const [, older] = await service.getAllForUser(me.toHexString());

		expect(older._id).toBe(convA.toHexString());
		expect(older.lastMessage!.conversation).toBe(convA.toHexString());
		expect(older.lastMessage!.sender._id).toBe(other.toHexString());
	});
});

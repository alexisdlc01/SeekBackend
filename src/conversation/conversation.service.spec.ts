import { ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { ConversationService } from "./conversation.service";

describe("ConversationService authorization", () => {
	const conversationId = new Types.ObjectId();
	const userId = new Types.ObjectId();
	let conversationModel: {
		findById: jest.Mock;
		updateOne: jest.Mock;
	};
	let messageModel: { create: jest.Mock };
	let gateway: { emitNewMessage: jest.Mock };
	let access: { assertCanAccess: jest.Mock };
	let service: ConversationService;

	beforeEach(() => {
		conversationModel = {
			findById: jest.fn(),
			updateOne: jest.fn().mockResolvedValue(undefined),
		};
		messageModel = { create: jest.fn() };
		gateway = { emitNewMessage: jest.fn() };
		access = { assertCanAccess: jest.fn().mockResolvedValue(undefined) };
		service = new ConversationService(
			conversationModel as never,
			messageModel as never,
			gateway as never,
			access as never,
		);
	});

	it("checks membership before creating a message", async () => {
		access.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(service.sendMessage(
			{ message: "Private message" },
			conversationId.toString(),
			userId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(messageModel.create).not.toHaveBeenCalled();
		expect(conversationModel.updateOne).not.toHaveBeenCalled();
		expect(gateway.emitNewMessage).not.toHaveBeenCalled();
	});

	it("checks membership before loading conversation contents", async () => {
		access.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(service.getById(
			conversationId.toString(),
			userId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(conversationModel.findById).not.toHaveBeenCalled();
	});
});

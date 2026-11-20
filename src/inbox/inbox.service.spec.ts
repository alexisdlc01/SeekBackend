import { Types } from "mongoose";
import { InboxService } from "./inbox.service";

const chain = (value: unknown) => {
	const q: any = { sort: () => q, populate: () => q, select: () => q, lean: () => q, exec: () => Promise.resolve(value) };
	return q;
};

describe("InboxService.getThread (seek thread)", () => {
	it("frees the grouped chat notification so later messages notify again", async () => {
		const conversationId = new Types.ObjectId();
		const userId = new Types.ObjectId();
		const messageModel = { find: jest.fn(() => chain([])), updateMany: jest.fn().mockResolvedValue({}) };
		const emailModel = { find: jest.fn(() => chain([])), updateMany: jest.fn().mockResolvedValue({}) };
		const conversationModel = { findById: jest.fn(() => chain({ name: "Chat" })) };
		const access = { assertCanAccess: jest.fn().mockResolvedValue(undefined) };
		const notifications = { markReadByKey: jest.fn().mockResolvedValue(undefined) };
		const service = new InboxService(
			conversationModel as any,
			messageModel as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			emailModel as any,
			{} as any,
			{} as any,
			{} as any,
			access as any,
			{} as any,
			notifications as any
		);
		jest.spyOn(service, "listThreads").mockResolvedValue([]);
		Object.assign(service, {
			replyFrom: jest.fn().mockResolvedValue(null),
			suggestedReply: jest.fn().mockResolvedValue(null),
			rentSummary: jest.fn().mockResolvedValue(null)
		});

		await service.getThread({ _id: userId, name: "A", role: "LANDLORD_AGENCY" } as any, `seek-${conversationId}`);

		expect(notifications.markReadByKey).toHaveBeenCalledWith(userId.toString(), `message:${conversationId}`);
	});
});

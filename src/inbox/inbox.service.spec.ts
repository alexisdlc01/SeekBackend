import { Types } from "mongoose";
import { InboxService } from "./inbox.service";

const chain = (value: unknown) => {
	const q: any = { sort: () => q, populate: () => q, select: () => q, lean: () => q, exec: () => Promise.resolve(value) };
	return q;
};

describe("InboxService.getThread (seek thread)", () => {
	const build = (conversation: Record<string, unknown>) => {
		const messageModel = { find: jest.fn(() => chain([])), updateMany: jest.fn().mockResolvedValue({}) };
		const emailModel = { find: jest.fn(() => chain([])), updateMany: jest.fn().mockResolvedValue({}) };
		const conversationModel = { findById: jest.fn(() => chain(conversation)) };
		const access = { assertCanAccess: jest.fn().mockResolvedValue(undefined) };
		const notifications = { markReadByKey: jest.fn().mockResolvedValue(undefined) };
		const service = new InboxService(conversationModel as any, messageModel as any, {} as any, {} as any, {} as any, {} as any, emailModel as any, {} as any, {} as any, {} as any, access as any, {} as any, notifications as any);
		jest.spyOn(service, "listThreads").mockResolvedValue([]);
		Object.assign(service, { replyFrom: jest.fn().mockResolvedValue(null), suggestedReply: jest.fn().mockResolvedValue(null), rentSummary: jest.fn().mockResolvedValue(null) });
		return service;
	};

	it("offers the Seek reply box only while the conversation is open", async () => {
		const user = { _id: new Types.ObjectId(), name: "A", role: "STUDENT" } as any;
		const thread = `seek-${new Types.ObjectId()}`;
		expect((await build({ name: "Chat" }).getThread(user, thread)).canReplyBySeek).toBe(true);
		expect((await build({ name: "Chat", closedAt: new Date() }).getThread(user, thread)).canReplyBySeek).toBe(false);
	});

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

describe("InboxService.seekMeta", () => {
	it.each([
		["ENDED", "Tenants · Seek", "Landlord · Seek"],
		["PENDING_ACCEPTANCE", "Applicant · Seek", "Seek group"]
	])("labels a %s tenancy thread correctly", async (status, landlordLabel, studentLabel) => {
		const landlord = new Types.ObjectId();
		const student = new Types.ObjectId();
		const conversation = new Types.ObjectId();
		const app = { _id: new Types.ObjectId(), conversation, listing: new Types.ObjectId(), landlord, owner: student, applicants: [student] };
		const tenancy = { _id: new Types.ObjectId(), application: app._id, tenants: [student], landlord, status };
		const find = (value: unknown) => jest.fn(() => chain(value));
		const service = new InboxService({} as any, {} as any, { find: find([app]) } as any, { find: find([tenancy]) } as any, { find: find([]) } as any, { find: find([]) } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
		const meta = (viewer: object) => (service as any).seekMeta(viewer, [conversation]).then((m: Map<string, any>) => m.get(conversation.toString()));
		expect((await meta({ _id: landlord, role: "LANDLORD_AGENCY" })).label).toBe(landlordLabel);
		expect((await meta({ _id: student, role: "STUDENT" })).label).toBe(studentLabel);
	});
});

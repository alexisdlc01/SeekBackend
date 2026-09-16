import {
	BadRequestException,
	ForbiddenException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { ConversationAccessService } from "./conversation-access.service";
import { ApplicationStage } from "../application/enums/application-stage.enum";

describe("ConversationAccessService", () => {
	const conversationId = new Types.ObjectId();
	const userId = new Types.ObjectId();
	let conversationModel: { exists: jest.Mock };
	let applicationModel: { exists: jest.Mock };
	let service: ConversationAccessService;

	beforeEach(() => {
		conversationModel = { exists: jest.fn().mockResolvedValue(null) };
		applicationModel = { exists: jest.fn().mockResolvedValue(null) };
		service = new ConversationAccessService(
			conversationModel as never,
			applicationModel as never,
		);
	});

	it("allows a user listed directly on the conversation", async () => {
		conversationModel.exists.mockResolvedValue({ _id: conversationId });

		await expect(service.assertCanAccess(
			conversationId.toString(),
			userId.toString(),
		)).resolves.toBeUndefined();
	});

	it("allows linked applicants, owners, and landlords of sent applications", async () => {
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.assertCanAccess(
			conversationId.toString(),
			userId.toString(),
		)).resolves.toBeUndefined();

		expect(applicationModel.exists).toHaveBeenCalledWith({
			conversation: conversationId,
			$or: [
				{ applicants: userId },
				{ owner: userId },
				{
					landlord: userId,
					stage: {
						$in: [
							ApplicationStage.SENT,
							ApplicationStage.ACCEPTED,
							ApplicationStage.REJECTED,
						]
					}
				},
			],
		});
	});

	it("forbids an authenticated outsider", async () => {
		await expect(service.assertCanAccess(
			conversationId.toString(),
			userId.toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("rejects malformed identifiers without querying the database", async () => {
		await expect(service.assertCanAccess(
			"not-an-object-id",
			userId.toString(),
		)).rejects.toBeInstanceOf(BadRequestException);
		expect(conversationModel.exists).not.toHaveBeenCalled();
		expect(applicationModel.exists).not.toHaveBeenCalled();
	});
});

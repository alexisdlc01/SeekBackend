import { Types } from "mongoose";
import { ApplicationController } from "./application.controller";

describe("ApplicationController", () => {
	let controller: ApplicationController;
	let applicationService: { getByConversation: jest.Mock };

	beforeEach(() => {
		applicationService = { getByConversation: jest.fn() };
		controller = new ApplicationController(applicationService as never);
	});

	it("should be defined", () => {
		expect(controller).toBeDefined();
	});

	it("passes the authenticated user to conversation authorization", async () => {
		const conversationId = new Types.ObjectId().toString();
		const userId = new Types.ObjectId();

		await controller.getByConversation(
			conversationId,
			{ _id: userId } as never,
		);

		expect(applicationService.getByConversation).toHaveBeenCalledWith(
			conversationId,
			userId.toString(),
		);
	});
});

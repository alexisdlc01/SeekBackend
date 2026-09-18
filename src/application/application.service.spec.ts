import { Types } from "mongoose";
import { ApplicationService } from "./application.service";
import { User } from "../users/users.schema";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ApplicationStage } from "./enums/application-stage.enum";

function documentFrom(value: Record<string, unknown>) {
	return {
		...value,
		toObject: () => value,
	};
}

describe("ApplicationService", () => {
	const listingId = new Types.ObjectId();
	const userId = new Types.ObjectId();
	const landlordId = new Types.ObjectId();
	const conversationId = new Types.ObjectId();
	const applicationId = new Types.ObjectId();
	const listing = {
		_id: listingId,
		landlord: landlordId,
		propertyTitle: "Market Street Flat",
	};
	const user = {
		_id: userId,
		name: "Student",
	} as User;

	let applicationModel: {
		findOne: jest.Mock;
		findById: jest.Mock;
		findOneAndUpdate: jest.Mock;
		create: jest.Mock;
	};
	let conversationModel: {
		create: jest.Mock;
		deleteOne: jest.Mock;
		updateOne: jest.Mock;
	};
	let listingService: {
		findPublishedListingById: jest.Mock;
	};
	let conversationAccessService: {
		assertCanAccess: jest.Mock;
	};
	let service: ApplicationService;

	beforeEach(() => {
		applicationModel = {
			findOne: jest.fn(),
			findById: jest.fn(),
			findOneAndUpdate: jest.fn(),
			create: jest.fn(),
		};
		conversationModel = {
			create: jest.fn(),
			deleteOne: jest.fn().mockResolvedValue(undefined),
			updateOne: jest.fn(),
		};
		listingService = {
			findPublishedListingById: jest.fn().mockResolvedValue(listing),
		};
		conversationAccessService = {
			assertCanAccess: jest.fn().mockResolvedValue(undefined),
		};
		service = new ApplicationService(
			applicationModel as never,
			conversationModel as never,
			listingService as never,
			{} as never,
			conversationAccessService as never,
		);
	});

	it("rejects a new application when a required document is missing", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(null),
		});
		listingService.findPublishedListingById.mockResolvedValue({
			...listing,
			requirements: [
				{
					name: "Identification",
					desc: "National ID or Passport",
					required: true,
				},
			],
		});

		await expect(service.create(listingId.toString(), user)).rejects.toThrow(
			"Missing required documents: Identification",
		);
		expect(conversationModel.create).not.toHaveBeenCalled();
	});

	it("rejects applications for listings that are not published and verified", async () => {
		listingService.findPublishedListingById.mockRejectedValue(
			new NotFoundException("Listing not found"),
		);

		await expect(service.create(listingId.toString(), user)).rejects.toThrow(
			"Listing not found",
		);
		expect(applicationModel.findOne).not.toHaveBeenCalled();
		expect(conversationModel.create).not.toHaveBeenCalled();
	});

	it("returns the existing application without creating another chat", async () => {
		const existing = documentFrom({
			_id: applicationId,
			listing: listingId,
			owner: userId,
			conversation: conversationId,
			applicants: [userId],
			landlord: landlordId,
		});
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(existing),
		});

		const result = await service.create(listingId.toString(), user);

		expect(result._id).toBe(applicationId.toString());
		expect(conversationModel.create).not.toHaveBeenCalled();
		expect(applicationModel.create).not.toHaveBeenCalled();
	});

	it("creates one keyed application and one conversation", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(null),
		});
		conversationModel.create.mockResolvedValue({ _id: conversationId });
		applicationModel.create.mockResolvedValue(
			documentFrom({
				_id: applicationId,
				listing: listingId,
				owner: userId,
				conversation: conversationId,
				applicants: [userId],
				landlord: landlordId,
			}),
		);

		await service.create(listingId.toString(), user);

		expect(conversationModel.create).toHaveBeenCalledTimes(1);
		expect(applicationModel.create).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationKey: `${listingId.toString()}:${userId.toString()}`,
			}),
		);
	});

	it("returns the winner and removes its unused chat when requests race", async () => {
		const winner = documentFrom({
			_id: applicationId,
			listing: listingId,
			owner: userId,
			conversation: conversationId,
			applicants: [userId],
			landlord: landlordId,
		});
		applicationModel.findOne
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(winner) });
		conversationModel.create.mockResolvedValue({ _id: conversationId });
		applicationModel.create.mockRejectedValue({ code: 11000 });

		const result = await service.create(listingId.toString(), user);

		expect(result._id).toBe(applicationId.toString());
		expect(conversationModel.deleteOne).toHaveBeenCalledWith({
			_id: conversationId,
		});
	});

	it("returns a linked application to an authorized conversation participant", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(documentFrom({
				_id: applicationId,
				listing: {
					_id: listingId,
					propertyTitle: "Market Street Flat",
					registerOfTitleKey: "private-title-key",
					registrationNumber: "private-registration",
					likedBy: [userId],
				},
				conversation: conversationId,
				owner: userId,
				applicants: [userId],
				landlord: landlordId,
			})),
		});

		const result = await service.getByConversation(
			conversationId.toString(),
			userId.toString(),
		);

		expect(conversationAccessService.assertCanAccess).toHaveBeenCalledWith(
			conversationId.toString(),
			userId.toString(),
		);
		expect(result.listing.registerOfTitleKey).toBeUndefined();
		expect(result.listing.registrationNumber).toBeUndefined();
		expect(result.listing.likedBy).toBeUndefined();
	});

	it("does not return a linked application to a conversation outsider", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(documentFrom({
				_id: applicationId,
				listing: listingId,
				conversation: conversationId,
				owner: userId,
				applicants: [userId],
				landlord: landlordId,
			})),
		});
		conversationAccessService.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(service.getByConversation(
			conversationId.toString(),
			new Types.ObjectId().toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("adds a joined applicant to both the application and conversation", async () => {
		const joinedUserId = new Types.ObjectId();
		applicationModel.findById.mockResolvedValue({
			_id: applicationId,
			conversation: conversationId,
			stage: ApplicationStage.NOT_SENT,
		});
		applicationModel.findOneAndUpdate.mockResolvedValue({ _id: applicationId });
		conversationModel.updateOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
		});

		await service.join(applicationId.toString(), joinedUserId.toString());

		expect(conversationModel.updateOne).toHaveBeenCalledWith(
			{ _id: conversationId },
			{ $addToSet: { users: joinedUserId } },
		);
	});
});

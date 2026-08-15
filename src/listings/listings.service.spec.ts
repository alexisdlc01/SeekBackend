import { Types } from "mongoose";
import { ConfigService } from "@nestjs/config";
import { ListingsGateway } from "./listings.gateway";
import { ListingsService } from "./listings.service";
import { Listing } from "./listings.schema";
import { User } from "../users/users.schema";

describe("ListingsService", () => {
	let service: ListingsService;
	let listingModel: Record<string, jest.Mock>;
	let gateway: Record<string, jest.Mock>;

	beforeEach(() => {
		listingModel = {
			create: jest.fn(),
			findById: jest.fn(),
			findByIdAndUpdate: jest.fn(),
			deleteOne: jest.fn()
		};
		gateway = {
			emitListingCreated: jest.fn(),
			emitListingUpdated: jest.fn(),
			emitListingDeleted: jest.fn()
		};
		service = new ListingsService(
			listingModel as any,
			gateway as unknown as ListingsGateway,
			{} as ConfigService
		);
	});

	it("passes the created draft to the owner-scoped gateway", async () => {
		const listing = makeListing(true);
		listingModel.create.mockResolvedValue(listing);

		await service.createDraft(makeLandlord());

		expect(gateway.emitListingCreated).toHaveBeenCalledWith(listing);
	});

	it("passes the deleted listing to the gateway so it can derive the owner room", async () => {
		const listing = makeListing(true);
		listingModel.findById.mockResolvedValue(listing);
		listingModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

		await service.deleteListing(listing._id.toString(), makeLandlord());

		expect(gateway.emitListingDeleted).toHaveBeenCalledWith(listing);
	});

	it("notifies the owner after a superuser verifies a listing", async () => {
		const listing = makeListing(false);
		listingModel.findByIdAndUpdate.mockReturnValue({
			exec: jest.fn().mockResolvedValue(listing)
		});

		await service.verifyListing(listing._id.toString());

		expect(gateway.emitListingUpdated).toHaveBeenCalledWith(listing);
	});

	function makeLandlord(): User {
		return { _id: new Types.ObjectId("64b64b64b64b64b64b64b64b") } as User;
	}

	function makeListing(isDraft: boolean): Listing {
		return {
			_id: new Types.ObjectId(),
			landlord: new Types.ObjectId("64b64b64b64b64b64b64b64b"),
			isDraft,
			isVerified: false
		} as Listing;
	}
});

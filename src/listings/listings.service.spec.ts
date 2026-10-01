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

	describe("filters", () => {
		let query: Record<string, jest.Mock>;

		beforeEach(() => {
			query = {
				select: jest.fn(),
				sort: jest.fn(),
				skip: jest.fn(),
				limit: jest.fn(),
				exec: jest.fn().mockResolvedValue([])
			};
			for (const step of ["select", "sort", "skip", "limit"]) {
				query[step].mockReturnValue(query);
			}
			listingModel.find = jest.fn().mockReturnValue(query);
		});

		it("sorts nearest first without a distance cutoff unless a radius is given", async () => {
			await service.filters({ lat: 56.34, lng: -2.79 } as never);

			const [mongoQuery] = listingModel.find.mock.calls[0];
			expect(mongoQuery.location.$near.$geometry.coordinates).toEqual([
				-2.79, 56.34
			]);
			expect(mongoQuery.location.$near.$maxDistance).toBeUndefined();
		});

		it("keeps an explicit radius", async () => {
			await service.filters({ lat: 56.34, lng: -2.79, radius: 2000 } as never);

			const [mongoQuery] = listingModel.find.mock.calls[0];
			expect(mongoQuery.location.$near.$maxDistance).toBe(2000);
		});

		it("returns one page of results when a page size is given", async () => {
			await service.filters({ lat: 56.34, lng: -2.79, page: 3, limit: 5 } as never);

			expect(query.skip).toHaveBeenCalledWith(10);
			expect(query.limit).toHaveBeenCalledWith(5);
			// $near already orders by distance; a sort would override it.
			expect(query.sort).not.toHaveBeenCalled();
		});

		it("pages in a stable order when there is no location", async () => {
			await service.filters({ page: 1, limit: 5 } as never);

			expect(query.sort).toHaveBeenCalledWith({ _id: -1 });
			expect(query.skip).toHaveBeenCalledWith(0);
			expect(query.limit).toHaveBeenCalledWith(5);
		});

		it("returns everything when no page size is given", async () => {
			await service.filters({} as never);

			expect(query.skip).not.toHaveBeenCalled();
			expect(query.limit).not.toHaveBeenCalled();
		});
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

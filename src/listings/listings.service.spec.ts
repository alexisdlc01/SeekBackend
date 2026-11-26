import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";
import { ConfigService } from "@nestjs/config";
import { ListingsGateway } from "./listings.gateway";
import { ListingsService } from "./listings.service";
import { Listing } from "./listings.schema";
import { User } from "../users/users.schema";
import { ApplicationService } from "../application/application.service";

describe("ListingsService", () => {
	let service: ListingsService;
	let listingModel: Record<string, jest.Mock>;
	let gateway: Record<string, jest.Mock>;
	let applicationModel: Record<string, jest.Mock>;
	let tenancyModel: Record<string, jest.Mock>;
	let applicationService: { releaseDeletedListing: jest.Mock };
	let moduleRef: { get: jest.Mock };

	beforeEach(() => {
		listingModel = {
			create: jest.fn(),
			findById: jest.fn(),
			findByIdAndUpdate: jest.fn(),
			deleteOne: jest.fn()
		};
		applicationModel = {
			aggregate: jest.fn().mockResolvedValue([]),
			distinct: jest.fn().mockResolvedValue([]),
			exists: jest.fn().mockResolvedValue(null)
		};
		tenancyModel = {
			exists: jest.fn().mockResolvedValue(null),
			distinct: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) })
		};
		gateway = {
			emitListingCreated: jest.fn(),
			emitListingUpdated: jest.fn(),
			emitListingDeleted: jest.fn()
		};
		applicationService = { releaseDeletedListing: jest.fn().mockResolvedValue(undefined) };
		moduleRef = { get: jest.fn().mockReturnValue(applicationService) };
		service = new ListingsService(
			listingModel as any,
			gateway as unknown as ListingsGateway,
			{ get: jest.fn() } as unknown as ConfigService,
			applicationModel as any,
			tenancyModel as any,
			moduleRef as any
		);
	});

	it("counts places left per viewing slot", async () => {
		const first = new Date("2026-12-01T10:00:00Z");
		const second = new Date("2026-12-01T11:00:00Z");
		applicationModel.aggregate.mockResolvedValue([{ _id: first, count: 2 }]);
		await expect(service.viewingSlotAvailability({
			_id: new Types.ObjectId(),
			viewingSlots: [first, second],
			viewingSlotCapacity: 2
		})).resolves.toEqual([{ at: first, remaining: 0 }, { at: second, remaining: 2 }]);
	});

	it("reports a listing as closed when let or past availableUntil", async () => {
		const _id = new Types.ObjectId();
		expect(await service.isClosed({ _id, availableUntil: new Date(Date.now() - 1000) })).toBe(true);
		expect(await service.isClosed({ _id, availableUntil: new Date(Date.now() + 86400000) })).toBe(false);
		applicationModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });
		expect(await service.isClosed({ _id })).toBe(true);
	});

	it("drops past viewing slots", async () => {
		applicationModel.aggregate.mockResolvedValue([]);
		const future = new Date(Date.now() + 86400000);
		await expect(service.viewingSlotAvailability({
			_id: new Types.ObjectId(),
			viewingSlots: [new Date(Date.now() - 86400000), future],
			viewingSlotCapacity: 1
		})).resolves.toEqual([{ at: future, remaining: 1 }]);
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

	it("releases the listing's applications before deleting it", async () => {
		const listing = makeListing(false);
		listingModel.findById.mockResolvedValue(listing);
		listingModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

		await service.deleteListing(listing._id.toString(), makeLandlord());

		expect(moduleRef.get).toHaveBeenCalledWith(ApplicationService, { strict: false });
		expect(applicationService.releaseDeletedListing).toHaveBeenCalledWith(listing._id);
		expect(applicationService.releaseDeletedListing.mock.invocationCallOrder[0]).toBeLessThan(listingModel.deleteOne.mock.invocationCallOrder[0]);
	});

	it("keeps the listing when releasing an application fails", async () => {
		const listing = makeListing(false);
		listingModel.findById.mockResolvedValue(listing);
		applicationService.releaseDeletedListing.mockRejectedValue(new Error("refund failed"));

		await expect(service.deleteListing(listing._id.toString(), makeLandlord())).rejects.toThrow("refund failed");
		expect(listingModel.deleteOne).not.toHaveBeenCalled();
		expect(gateway.emitListingDeleted).not.toHaveBeenCalled();
	});

	it.each([
		["an accepted or signed application", "application"],
		["a tenancy", "tenancy"]
	])("refuses to delete a listing with %s", async (_label, kind) => {
		const listing = makeListing(false);
		listingModel.findById.mockResolvedValue(listing);
		(kind === "application" ? applicationModel : tenancyModel).exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.deleteListing(listing._id.toString(), makeLandlord())).rejects.toThrow("cannot be deleted");
		expect(listingModel.deleteOne).not.toHaveBeenCalled();
		expect(gateway.emitListingDeleted).not.toHaveBeenCalled();
		expect(applicationService.releaseDeletedListing).not.toHaveBeenCalled();
	});

	describe("availableFrom in the past", () => {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString();
		const found = (doc: object) => ({
			select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }) })
		});

		it("refuses to publish a draft dated yesterday", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: true, availableFrom: new Date(yesterday) }));
			await expect(service.publishDraft(new Types.ObjectId().toString(), makeLandlord())).rejects.toThrow(
				"Available-from date is in the past. Pick today or a later date."
			);
		});

		it("refuses to move a published listing's date into the past", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, availableFrom: new Date("2030-01-01") }));
			await expect(
				service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { availableFrom: yesterday } as never)
			).rejects.toThrow("in the past");
		});

		it("lets a published listing keep an old date it already had", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, availableFrom: new Date(yesterday) }));
			listingModel.findOneAndUpdate = jest.fn().mockResolvedValue(makeListing(false));
			await expect(
				service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { availableFrom: yesterday } as never)
			).resolves.toBeDefined();
		});
	});

	describe("availableUntil window", () => {
		const found = (doc: object) => ({
			select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }) })
		});

		it.each([
			["before availableFrom", "2099-09-01", "2099-06-01"],
			["already past", "2099-09-01", "2020-01-01"]
		])("refuses to publish a draft whose availableUntil is %s", async (_l, from, until) => {
			listingModel.findOne = jest
				.fn()
				.mockReturnValue(found({ isDraft: true, availableFrom: new Date(from), availableUntil: new Date(until) }));
			await expect(service.publishDraft(new Types.ObjectId().toString(), makeLandlord())).rejects.toThrow(
				"Available-until date"
			);
		});

		it("refuses to move a live listing's availableUntil before its availableFrom", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, availableFrom: new Date("2099-09-01") }));
			await expect(
				service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { availableUntil: "2099-06-01" } as never)
			).rejects.toThrow("Available-until date");
		});
	});

	it("rejects a Scottish holding deposit above one week of per-room rent when the landlord sets it", async () => {
		const id = new Types.ObjectId();
		listingModel.findOne = jest.fn().mockReturnValue({
			select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ monthlyRent: 650, numOfPeople: 1, nation: "SCOTLAND" }) }) })
		});
		listingModel.findOneAndUpdate = jest.fn();

		await expect(service.updateDraft(id.toString(), makeLandlord(), { holdingDeposit: 150.01 } as never))
			.rejects.toThrow("one-week cap of £150.00 per room");
		expect(listingModel.findOneAndUpdate).not.toHaveBeenCalled();
	});

	describe("deposit cap on step saves", () => {
		// Five weeks of £1000 in England is £1153.85; Northern Ireland caps at one month (£1000).
		const stored = { isDraft: true, monthlyRent: 1000, numOfPeople: 1, securityDeposit: 1150, nation: "ENGLAND" };
		beforeEach(() => {
			listingModel.findOne = jest.fn().mockReturnValue({
				select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(stored) }) })
			});
			listingModel.findOneAndUpdate = jest.fn().mockResolvedValue(makeListing(true));
		});

		it("saves step 1 when only the nation change puts the stored deposit over the cap", async () => {
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { nation: "NORTHERN_IRELAND", draftStep: 1 } as never);
			expect(listingModel.findOneAndUpdate).toHaveBeenCalled();
		});

		it("saves step 1 when the unchanged deposit is resent with the nation change", async () => {
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), {
				nation: "NORTHERN_IRELAND", securityDeposit: 1150, monthlyRent: 1000, draftStep: 1
			} as never);
			expect(listingModel.findOneAndUpdate).toHaveBeenCalled();
		});

		it("still refuses a step save that sets the deposit over the cap", async () => {
			await expect(service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), {
				nation: "NORTHERN_IRELAND", securityDeposit: 1100, draftStep: 1
			} as never)).rejects.toThrow("Lower it before letting");
			expect(listingModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("refuses a nation change alone on a live listing that would put its deposit over the cap, saying what to do", async () => {
			listingModel.findOne = jest.fn().mockReturnValue({
				select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ ...stored, isDraft: false }) }) })
			});
			const saving = service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { nation: "NORTHERN_IRELAND", draftStep: 1 } as never);
			await expect(saving).rejects.toBeInstanceOf(BadRequestException);
			await expect(saving).rejects.toThrow("Lower the deposit first, then change the nation or number of people.");
			expect(listingModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("still refuses to publish with the deposit over the cap, even with no money field sent", async () => {
			await expect(service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), {
				nation: "NORTHERN_IRELAND", holdingDeposit: undefined
			} as never)).rejects.toThrow("Lower it before letting");
		});
	});

	describe("nation change", () => {
		beforeEach(() => {
			listingModel.findOne = jest.fn().mockReturnValue({
				select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ isDraft: false, nation: "SCOTLAND" }) }) })
			});
			listingModel.findOneAndUpdate = jest.fn().mockResolvedValue(makeListing(false));
		});

		it("refuses to change the nation of a listing with a tenancy", async () => {
			tenancyModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { nation: "ENGLAND", draftStep: 1 } as never))
				.rejects.toThrow("The nation cannot change once a tenancy or accepted application exists.");
			expect(applicationModel.exists.mock.calls[0][0].stage.$in).toEqual(["ACCEPTED", "SIGNED"]);
			expect(listingModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("changes the nation of a listing with no tenancy or accepted application", async () => {
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { nation: "ENGLAND", draftStep: 1 } as never);
			expect(listingModel.findOneAndUpdate.mock.calls[0][1].$set.nation).toBe("ENGLAND");
		});
	});

	describe("viewing slots", () => {
		const found = (doc: object | null) => ({
			select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }) })
		});
		const past = new Date(Date.now() - 86400000);
		const future = new Date(Date.now() + 7 * 86400000);

		beforeEach(() => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ viewingSlots: [past, future] }));
			listingModel.findOneAndUpdate = jest.fn().mockResolvedValue(makeListing(false));
		});

		it("drops a stored slot that has passed instead of rejecting the save", async () => {
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), {
				viewingSlots: [past.toISOString(), future.toISOString()]
			} as never);
			expect(listingModel.findOneAndUpdate.mock.calls[0][1].$set.viewingSlots).toEqual([future]);
		});

		it("still refuses a newly added slot in the past", async () => {
			await expect(
				service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), {
					viewingSlots: [new Date(Date.now() - 3600000).toISOString()]
				} as never)
			).rejects.toThrow("Viewing times must be in the future.");
		});
	});

	describe("reviewed fields", () => {
		const found = (doc: object | null) => ({
			select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }) })
		});
		const uuid = "123e4567-e89b-12d3-a456-426614174000";
		const ownKey = `private/64b64b64b64b64b64b64b64b/${uuid}.pdf`;
		const updateOf = () => listingModel.findOneAndUpdate.mock.calls[0][1].$set;

		beforeEach(() => {
			listingModel.findOneAndUpdate = jest.fn().mockResolvedValue(makeListing(false));
		});

		it("refuses a register-of-title key minted for someone else, such as an applicant's passport", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: true }));
			const studentKey = `private/${new Types.ObjectId().toHexString()}/${uuid}.pdf`;
			await expect(
				service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { registerOfTitleKey: studentKey } as never)
			).rejects.toThrow("Document key was not issued to this account.");
			expect(listingModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("accepts the landlord's own key and an unchanged legacy key", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: true, registerOfTitleKey: "private/old.pdf" }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { registerOfTitleKey: "private/old.pdf" } as never);
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { registerOfTitleKey: ownKey } as never);
			expect(listingModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
		});

		it("re-geocodes a live listing when only the postcode changes, filling the rest from the stored address", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, streetAddress: "1 Road", cityTown: "St Andrews", postcodeZIP: "KY16 9AA", country: "UK" }));
			const geocode = jest.spyOn(service, "getCoordinates").mockResolvedValue({ formatted_address: "1 Road, KY16 9XX", lat: 56.3, lng: -2.8 });
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { postcodeZIP: "KY16 9XX" } as never);
			expect(geocode).toHaveBeenCalledWith("1 Road", "St Andrews", "KY16 9XX", "UK");
			expect(updateOf().location).toEqual({ type: "Point", coordinates: [-2.8, 56.3] });
		});

		it("sends a verified live listing back to moderation when its address changes", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, streetAddress: "1 Old Road" }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { streetAddress: "9 New Road" } as never);
			expect(updateOf().isVerified).toBe(false);
		});

		it("sends a verified live listing back to moderation when a certificate expiry date changes", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, gasSafetyExpiry: new Date("2027-06-01T00:00:00Z") }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { gasSafetyExpiry: "2026-01-01T00:00:00Z" } as never);
			expect(updateOf().isVerified).toBe(false);
		});

		it("keeps verification when the same certificate date is resent", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, eicrExpiry: new Date("2027-06-01T00:00:00Z") }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { eicrExpiry: "2027-06-01T00:00:00Z" } as never);
			expect(updateOf().isVerified).toBeUndefined();
		});

		it("keeps verification when only an unreviewed field is sent, even with reviewed keys present as undefined", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, photos: ["a.jpg"] }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { videoTourLink: "https://youtu.be/x", photos: undefined } as never);
			expect(updateOf().isVerified).toBeUndefined();
		});

		it("keeps verification when the reviewed fields are resent unchanged", async () => {
			listingModel.findOne = jest.fn().mockReturnValue(found({ isDraft: false, streetAddress: "1 Old Road", photos: ["a.jpg"] }));
			await service.updateDraft(new Types.ObjectId().toString(), makeLandlord(), { streetAddress: "1 Old Road", photos: ["a.jpg"] } as never);
			expect(updateOf().isVerified).toBeUndefined();
		});
	});

	describe("filters", () => {
		let query: Record<string, jest.Mock>;

		beforeEach(() => {
			query = {
				select: jest.fn(),
				sort: jest.fn(),
				skip: jest.fn(),
				limit: jest.fn(),
				lean: jest.fn(),
				exec: jest.fn().mockResolvedValue([])
			};
			for (const step of ["select", "sort", "skip", "limit", "lean"]) {
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

		it("hides listings a household has already accepted from public search", async () => {
			const let_ = new Types.ObjectId();
			applicationModel.distinct.mockResolvedValue([let_]);
			await service.filters({} as never);

			expect(applicationModel.distinct.mock.calls[0][1].stage.$in).toEqual(["ACCEPTED", "SIGNED"]);
			expect(listingModel.find.mock.calls[0][0]._id).toEqual({ $nin: [let_] });
		});

		it("puts a listing back in public search once its tenancy has ended, keeps it hidden while the tenancy runs", async () => {
			const endedApplication = new Types.ObjectId();
			const ended = { application: endedApplication, listing: new Types.ObjectId() };
			const running = { application: new Types.ObjectId(), listing: new Types.ObjectId() };
			tenancyModel.distinct.mockReturnValue({ exec: jest.fn().mockResolvedValue([endedApplication, null]) });
			// Like Mongo: accepted applications minus those the query leaves out.
			applicationModel.distinct.mockImplementation(async (_field: string, filter: any) => [ended, running]
				.filter(row => !filter._id.$nin.some((id: Types.ObjectId) => id.equals(row.application)))
				.map(row => row.listing));
			await service.filters({} as never);

			expect(tenancyModel.distinct).toHaveBeenCalledWith("application", { status: "ENDED" });
			expect(listingModel.find.mock.calls[0][0]._id).toEqual({ $nin: [running.listing] });
		});

		it("hides listings whose availableUntil has passed, alongside a text search", async () => {
			await service.filters({ text: "flat" } as never);

			const [mongoQuery] = listingModel.find.mock.calls[0];
			expectStillAvailable(mongoQuery);
			expect(mongoQuery.$or).toHaveLength(6);
		});

		it("returns everything when no page size is given", async () => {
			await service.filters({} as never);

			expect(query.skip).not.toHaveBeenCalled();
			expect(query.limit).not.toHaveBeenCalled();
		});
	});

	describe("public lists skip listings whose availableUntil has passed", () => {
		beforeEach(() => {
			const query = { select: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) };
			listingModel.find = jest.fn().mockReturnValue(query);
			listingModel.findOne = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(null) });
		});

		it("all verified listings", async () => {
			await service.getAllVerifiedListings();
			expectStillAvailable(listingModel.find.mock.calls[0][0]);
		});

		it("liked listings", async () => {
			await service.getLiked(makeLandlord());
			expectStillAvailable(listingModel.find.mock.calls[0][0]);
		});

		it("liked listings leave out a property another household already let", async () => {
			const let_ = new Types.ObjectId();
			applicationModel.distinct.mockResolvedValue([let_]);
			await service.getLiked(makeLandlord());
			expect(listingModel.find.mock.calls[0][0]._id).toEqual({ $nin: [let_] });
		});

		it("but one published listing stays readable for households that already applied", async () => {
			await expect(service.findPublishedListingById(new Types.ObjectId().toString())).rejects.toThrow("Listing not found");
			const [mongoQuery] = listingModel.findOne.mock.calls[0];
			expect(mongoQuery.$and).toBeUndefined();
			expect(mongoQuery.availableUntil).toBeUndefined();
		});
	});

	function expectStillAvailable(mongoQuery: { $and?: { $or: Record<string, unknown>[] }[] }) {
		const [condition] = mongoQuery.$and ?? [];
		expect(condition.$or).toEqual([{ availableUntil: null }, { availableUntil: { $gt: expect.any(Date) } }]);
		const after = (condition.$or[1].availableUntil as { $gt: Date }).$gt;
		expect(Math.abs(after.getTime() - Date.now())).toBeLessThan(5000);
	}

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

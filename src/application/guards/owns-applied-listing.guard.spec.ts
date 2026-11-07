import { ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Types } from "mongoose";
import { ListingsService } from "../../listings/listings.service";
import { ApplicationService } from "../application.service";
import { OwnsAppliedListingGuard } from "./owns-applied-listing.guard";

function contextFor(userId: Types.ObjectId, applicationId: Types.ObjectId): ExecutionContext {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				user: { _id: userId },
				params: { id: applicationId.toString() }
			})
		})
	} as unknown as ExecutionContext;
}

describe("OwnsAppliedListingGuard", () => {
	const landlordId = new Types.ObjectId();
	const listingId = new Types.ObjectId();
	const applicationId = new Types.ObjectId();

	// Only the models are faked. The real services run so the guard sees what it
	// gets in production: findApplicationById returns a serialised DTO, in which
	// `listing` is a Listing instance rather than the stored ObjectId.
	const applicationModel = {
		findById: jest.fn().mockReturnValue({
			exec: jest.fn().mockResolvedValue({
				toObject: () => ({
					_id: applicationId,
					listing: listingId,
					landlord: landlordId,
					conversation: new Types.ObjectId(),
					applicants: [new Types.ObjectId()],
					owner: new Types.ObjectId()
				})
			})
		})
	};
	const listingModel = {
		findById: jest.fn().mockReturnValue({
			exec: jest.fn().mockResolvedValue({ landlord: landlordId })
		})
	};
	const applicationService = new ApplicationService(
		applicationModel as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);
	const listingService = new ListingsService(
		listingModel as never,
		{} as never,
		{} as never,
		{} as never
	);

	// Resolve the guard through Nest's injector, the way @UseGuards() does in
	// production, so missing constructor metadata (no @Injectable) would show
	// up here as undefined dependencies rather than only at runtime.
	async function resolveGuard() {
		const module = await Test.createTestingModule({
			providers: [
				OwnsAppliedListingGuard,
				{ provide: ApplicationService, useValue: applicationService },
				{ provide: ListingsService, useValue: listingService }
			]
		}).compile();
		return module.get(OwnsAppliedListingGuard);
	}

	it("allows the landlord who owns the applied-to listing", async () => {
		const guard = await resolveGuard();

		await expect(
			guard.canActivate(contextFor(landlordId, applicationId))
		).resolves.toBe(true);
		expect(applicationModel.findById).toHaveBeenCalledWith(
			applicationId.toString()
		);
		expect(listingModel.findById).toHaveBeenCalledWith(
			listingId.toString()
		);
	});

	it("denies a landlord who does not own the listing", async () => {
		const guard = await resolveGuard();

		await expect(
			guard.canActivate(contextFor(new Types.ObjectId(), applicationId))
		).resolves.toBe(false);
	});
});

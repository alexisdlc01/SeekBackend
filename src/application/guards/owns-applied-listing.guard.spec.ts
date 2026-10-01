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

	const applicationService = {
		findApplicationById: jest.fn().mockResolvedValue({ listing: listingId })
	};
	const listingService = {
		findListingById: jest.fn().mockResolvedValue({ landlord: landlordId })
	};

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
		expect(applicationService.findApplicationById).toHaveBeenCalledWith(
			applicationId.toString()
		);
		expect(listingService.findListingById).toHaveBeenCalledWith(
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

import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { ListingsService } from "../../listings/listings.service";
import { ApplicationService } from "../application.service";

// @Injectable() is required for Nest to inject the constructor dependencies;
// without it the guard is constructed with them undefined.
@Injectable()
export class OwnsAppliedListingGuard implements CanActivate {
	constructor(
		private readonly listingService: ListingsService,
		private readonly applicationService: ApplicationService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user = request.user;

		if (!user || !user._id) {
			throw new ForbiddenException("User not authenticated");
		}

		const applicationId = request.params.id;
		const application =
			await this.applicationService.findApplicationById(applicationId);

		if (!application) {
			throw new NotFoundException("Application not found");
		}
		// findApplicationById returns a DTO, so `listing` is a Listing instance
		// rather than the stored ObjectId, and its toString() is "[object Object]".
		const listingId = application.listing._id.toString();

		const listing = await this.listingService.findListingById(listingId);

		if (!listing) {
			throw new NotFoundException("Listing not found");
		}

		return listing.landlord.toString() === user._id.toString();
	}
}

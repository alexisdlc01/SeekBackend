import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	NotFoundException
} from "@nestjs/common";
import { ListingsService } from "../../listings/listings.service";
import { ApplicationService } from "../application.service";
import { UsersRepository } from "../../users/users.repository";

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
		const listingId = application.listing.toString();

		const listing = await this.listingService.findListingById(listingId);

		if (!listing) {
			throw new NotFoundException("Listing not found");
		}

		return listing.landlord.toString() === user._id.toString();
	}
}

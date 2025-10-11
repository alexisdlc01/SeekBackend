import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ForbiddenException
} from "@nestjs/common";
import { ListingsService } from "../listings.service";

@Injectable()
export class OwnsListingGuard implements CanActivate {
	constructor(private readonly listingsService: ListingsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user = request.user;

		if (!user || !user._id) {
			throw new ForbiddenException("User not authenticated");
		}

		const listingId = request.params.id;

		const listing = await this.listingsService.findListingById(listingId);
		if (!listing) {
			throw new ForbiddenException("Listing not found");
		}

		if (listing.landlord.toString() !== user._id.toString()) {
			throw new ForbiddenException("You do not own this listing");
		}

		return true;
	}
}

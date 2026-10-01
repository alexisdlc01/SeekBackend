import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { ListingsService } from "../../listings/listings.service";

/**
 * For routes whose `:id` is a listing id rather than an application id.
 *
 * `OwnsAppliedListingGuard` resolves the parameter as an application, which is
 * correct for `/application/:id/approve` but wrong for `/application/listing/:id`
 * — there it never matches, so the route always 404s and the ownership check it
 * appears to perform never actually runs.
 */
@Injectable()
export class OwnsListingParamGuard implements CanActivate {
	constructor(private readonly listingService: ListingsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user = request.user;

		if (!user?._id) {
			throw new ForbiddenException("User not authenticated");
		}

		const listing = await this.listingService.findListingById(
			request.params.id
		);
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}

		if (listing.landlord.toString() !== user._id.toString()) {
			throw new ForbiddenException("You do not own this listing");
		}

		return true;
	}
}

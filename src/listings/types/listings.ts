import { Listing } from "../listings.schema";

export type ListingSocketPayload = Omit<
	Listing,
	"_id" | "landlord" | "registerOfTitleKey" | "registrationNumber" | "likedBy"
> & {
	_id: string;
	landlord: string;
};

export interface ServerToClientEvents {
	listingUpdated: (payload: ListingSocketPayload) => void;
	listingDeleted: (id: string) => void;
	listingCreated: (payload: ListingSocketPayload) => void;
}

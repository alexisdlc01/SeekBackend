import { Listing } from "../listings.schema";

export interface ServerToClientEvents {
	listingUpdated: (payload: Listing) => void;
	listingDeleted: (id: string) => void;
	listingCreated: (payload: Listing) => void;
}

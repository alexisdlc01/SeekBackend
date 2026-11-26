import {
	Injectable,
	forwardRef,
	Inject,
	BadRequestException,
	ConflictException,
	NotFoundException,
	UnauthorizedException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ModuleRef } from "@nestjs/core";
import { Listing, ViewingSlotAvailability } from "./listings.schema";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { endedTenancyApplications, Tenancy } from "../tenancies/tenancy.schema";
import { Model, Types } from "mongoose";
import { CreateListingDto } from "./dto/create-listing.dto";
import { User } from "../users/users.schema";
import { ListingsGateway } from "./listings.gateway";
import { InvalidRequest } from "@aws-sdk/client-s3";
import { LikedListingsDto } from "./dto/liked-listings.dto";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { ListingFilterDto } from "./dto/listing-filter.dto";
import { Nation } from "./enums/nation.enum";
import { ModerationStatus } from "./enums/moderation-status.enum";
import { complianceComplete, listingDepositCompliance } from "../tenancies/compliance";
import { isKeyOwnedBy } from "../upload/object-key";
import {
	assertAvailabilityWindow,
	assertAvailableFromNotPast,
	normaliseCriteria,
	normaliseViewingSlots,
	plansAfterNationChange,
	resolvePaymentPlans
} from "./listing-rules";

type DraftUpdateData = Partial<Omit<CreateListingDto, "viewingSlots">> & {
	viewingSlots?: string[] | Date[];
	draftStep?: number;
	location?: {
		type: "Point";
		coordinates: [number, number];
	};
	formatted_address?: string;
};

/** What moderation checks: a change on a live listing re-runs the automatic check (ListingModerationService). */
const REVIEWED_FIELDS = ["propertyTitle", "propertyDesc", "amenities", "streetAddress", "cityTown", "postcodeZIP", "country", "photos", "monthlyRent", "numOfPeople", "registrationNumber", "registerOfTitleKey", "propertyType", "bedroomsCount", "availableFrom", "gasSafetyExpiry", "eicrExpiry"] as const;

const ADDRESS_FIELDS = ["streetAddress", "cityTown", "postcodeZIP", "country"] as const;

export type ListingWithCoordinates = Listing & {
	lat: number | null;
	lng: number | null;
	rentPerPerson: number | null;
};

/** Public reads only: a listing whose availableUntil has passed can no longer be let (null also matches a missing field). */
const stillAvailable = () => ({ $or: [{ availableUntil: null }, { availableUntil: { $gt: new Date() } }] });

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Flattens the GeoJSON point into lat/lng for map clients. */
export function withCoordinates(listing: Listing): ListingWithCoordinates {
	const coordinates = listing.location?.coordinates;
	const hasPoint = Array.isArray(coordinates) && coordinates.length === 2;
	const people = Math.max(1, listing.numOfPeople ?? 1);
	return {
		...listing,
		lat: hasPoint ? coordinates[1] : null,
		lng: hasPoint ? coordinates[0] : null,
		rentPerPerson:
			typeof listing.monthlyRent === "number"
				? Math.round(listing.monthlyRent / people)
				: null
	};
}

@Injectable()
export class ListingsService {
	constructor(
		@InjectModel(Listing.name)
		private readonly listingModel: Model<Listing>,
		private readonly listingsGateway: ListingsGateway,
		private readonly configService: ConfigService,
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		@InjectModel(Tenancy.name)
		private readonly tenancyModel: Model<Tenancy>,
		private readonly moduleRef: ModuleRef
	) {}

	/** Places left per viewing slot: capacity minus open households already booked at that time. */
	async viewingSlotAvailability(listing: Pick<Listing, "_id" | "viewingSlots" | "viewingSlotCapacity">): Promise<ViewingSlotAvailability[]> {
		const slots = (listing.viewingSlots ?? []).map(slot => new Date(slot)).filter(slot => slot.getTime() > Date.now());
		if (slots.length === 0) return [];
		const booked: { _id: Date; count: number }[] = await this.applicationModel.aggregate([
			{ $match: {
				listing: new Types.ObjectId(listing._id.toString()),
				viewingAt: { $in: slots },
				stage: { $in: [ApplicationStage.SENT, ApplicationStage.VIEWED, ApplicationStage.OFFERED] }
			} },
			{ $group: { _id: "$viewingAt", count: { $sum: 1 } } }
		]);
		const counts = new Map(booked.map(slot => [new Date(slot._id).getTime(), slot.count]));
		const capacity = Math.max(1, listing.viewingSlotCapacity ?? 1);
		return slots.map(at => ({ at, remaining: Math.max(0, capacity - (counts.get(at.getTime()) ?? 0)) }));
	}

	async createDraft(user: User): Promise<string> {
		const newListing: Listing = await this.listingModel.create({
			landlord: new Types.ObjectId(user._id),
			isDraft: true
		});
		this.listingsGateway.emitListingCreated(newListing);
		return newListing._id.toString();
	}

	async updateDraft(
		listingId: string,
		landlord: User,
		data: Partial<DraftUpdateData>
	): Promise<Listing> {
		const update: Record<string, unknown> = { ...data, lastUpdated: new Date() };
		if (data.nation !== undefined) {
			const stored = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("nation")
				.lean()
				.exec();
			// Tenancy rules (notice, deposit, end dates) read the listing's current nation: it is fixed once let.
			if (stored && (data.nation ?? Nation.ENGLAND) !== (stored.nation ?? Nation.ENGLAND) && await this.isLet(new Types.ObjectId(listingId))) {
				throw new ConflictException("The nation cannot change once a tenancy or accepted application exists.");
			}
		}
		if (data.availableFrom || data.availableUntil) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("isDraft availableFrom availableUntil")
				.lean()
				.exec();
			// Drafts may hold any date until publish; a live listing may keep its date but not move it into the past.
			const moved = !!data.availableFrom && current?.availableFrom?.getTime() !== new Date(data.availableFrom).getTime();
			if (current && !current.isDraft && moved) assertAvailableFromNotPast(data.availableFrom!);
			// Drafts are checked at publish; a live listing must stay consistent on every edit.
			if (current && !current.isDraft && (moved || data.availableUntil)) {
				assertAvailabilityWindow(data.availableFrom ?? current.availableFrom, data.availableUntil ?? current.availableUntil);
			}
		}
		// By value, not key: a DTO instance carries every declared field, unset ones as undefined.
		const reviewed = REVIEWED_FIELDS.filter(key => data[key] !== undefined);
		if (reviewed.length > 0) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select(["isDraft", "streetAddress", "cityTown", "postcodeZIP", "country", ...reviewed].join(" "))
				.lean()
				.exec();
			// Stored dates come back as Date: compare by time, so resending the same date is not a change.
			const changed = reviewed.filter(key => {
				const stored = (current as Record<string, unknown> | null)?.[key];
				return stored instanceof Date && data[key] ? new Date(data[key] as string).getTime() !== stored.getTime() : JSON.stringify(data[key]) !== JSON.stringify(stored);
			});
			// Only a key minted for this landlord: an applicant's key stored here would skip the share checks on download.
			if (changed.includes("registerOfTitleKey") && data.registerOfTitleKey && !isKeyOwnedBy(data.registerOfTitleKey, landlord._id.toString())) {
				throw new BadRequestException("Document key was not issued to this account.");
			}
			// New content goes back through the automatic check (the controller runs it after this save).
			if (current && !current.isDraft && changed.length > 0) {
				update.isVerified = false;
				// PENDING until checked, so the sweeper retries it if the check in this request fails.
				update.moderationStatus = ModerationStatus.PENDING;
				// A moved address must move the map pin too; publish already does this, the step saves do not.
				if (ADDRESS_FIELDS.some(key => changed.includes(key))) {
					const stored = current as unknown as Record<string, string>;
					const merged = (key: (typeof ADDRESS_FIELDS)[number]) => (data[key] as string | undefined) ?? stored[key];
					const place = await this.getCoordinates(merged("streetAddress"), merged("cityTown"), merged("postcodeZIP"), merged("country"));
					if (place) {
						update.formatted_address = place.formatted_address;
						update.location = { type: "Point", coordinates: [place.lng, place.lat] };
					}
				}
			}
		}
		if (data.criteria) update.criteria = normaliseCriteria(data.criteria);
		if (data.viewingSlots) {
			// Slots already stored that have since passed are dropped; a newly added past slot is still refused.
			const stored = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("viewingSlots")
				.lean()
				.exec();
			const lapsed = new Set((stored?.viewingSlots ?? []).map(slot => new Date(slot).getTime()).filter(time => time <= Date.now()));
			update.viewingSlots = normaliseViewingSlots((data.viewingSlots as string[]).filter(slot => !lapsed.has(new Date(slot).getTime())));
		}
		const money = (["holdingDeposit", "securityDeposit", "monthlyRent"] as const).filter(key => data[key] !== undefined);
		const reshaped = (["numOfPeople", "nation"] as const).some(key => data[key] !== undefined);
		if (data.draftStep === undefined || money.length > 0 || reshaped) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("isDraft monthlyRent numOfPeople securityDeposit holdingDeposit nation")
				.lean()
				.exec();
			const sent = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
			const moved = money.some(key => Number(data[key]) !== Number((current as Record<string, unknown> | null)?.[key]));
			const live = !!current && !current.isDraft;
			// Publish (no draftStep) and a live listing always check: a public listing never sits above the legal cap.
			// A draft's step save checks only when it changes rent or a deposit: a nation or people change alone
			// must not block step 1, which has no deposit field to fix it; publish catches it.
			// Deposit at most 5 weeks' rent (2 months in Scotland), holding deposit always at most 1 week's per room.
			const overCap = data.draftStep === undefined || live || moved
				? listingDepositCompliance({ ...current, ...sent, _id: new Types.ObjectId(listingId) } as never)
				: [];
			if (overCap.length > 0) {
				const howTo = live && !moved && reshaped
					? " Lower the deposit first, then change the nation or number of people."
					: "";
				throw new BadRequestException(overCap.map(item => item.message).join(" ") + howTo);
			}
		}
		if (data.paymentPlans || data.nation) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("nation paymentPlans")
				.lean()
				.exec();
			const nation = data.nation ?? current?.nation ?? Nation.ENGLAND;
			update.paymentPlans = data.paymentPlans
				? resolvePaymentPlans(nation, data.paymentPlans)
				: plansAfterNationChange(nation, current?.paymentPlans);
		}
		const listing = await this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: update },
			{ new: true }
		);
		if (listing) {
			this.listingsGateway.emitListingUpdated(listing);
		}
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
		return listing;
	}

	async publishDraft(listingId: string, landlord: User): Promise<Listing> {
		const draft = await this.listingModel
			.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
			.select("isDraft availableFrom availableUntil")
			.lean()
			.exec();
		if (draft?.isDraft && draft.availableFrom) assertAvailableFromNotPast(draft.availableFrom);
		if (draft?.isDraft) assertAvailabilityWindow(draft.availableFrom, draft.availableUntil);
		const listing = await this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: { isDraft: false, lastUpdated: new Date() } },
			{ new: true }
		);
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
		this.listingsGateway.emitListingUpdated(listing);
		return listing;
	}

	async deleteListing(
		listingId: string,
		landlord: User
	): Promise<{ message: string }> {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingModel.findById(listingId);
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}

		if (listing.landlord.toString() !== landlord._id.toString()) {
			throw new UnauthorizedException(
				"Unauthorized: You do not own this listing"
			);
		}

		// An accepted/signed application or any tenancy references the listing; deleting it would orphan them.
		if (await this.isLet(listing._id)) {
			throw new ConflictException("A listing with an accepted application or a tenancy cannot be deleted.");
		}

		// Before deleteOne: reject() reads the listing title. A failure keeps the listing so no deposit is orphaned.
		// Imported at call time: application.service imports this file, a top-level import would be circular.
		const { ApplicationService } = await import("../application/application.service");
		await this.moduleRef.get(ApplicationService, { strict: false }).releaseDeletedListing(listing._id);
		await this.listingModel.deleteOne({ _id: listingId });
		this.listingsGateway.emitListingDeleted(listing);
		return { message: "Listing successfully deleted" };
	}

	private async isLet(listingId: Types.ObjectId): Promise<boolean> {
		const [let_, tenancy] = await Promise.all([
			this.applicationModel.exists({ listing: listingId, stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] } }),
			this.tenancyModel.exists({ listing: listingId })
		]);
		return !!(let_ || tenancy);
	}

	async getAllUnverifiedListings(): Promise<Listing[]> {
		return (
			(await this.listingModel
				.find({ isVerified: false, isDraft: false })
				.sort({ createdAt: -1 })
				.exec()) ?? []
		);
	}

	/** Listings a household has accepted and whose tenancy has not ended: not open to applicants, so hidden from public search. */
	private async letListingIds(): Promise<Types.ObjectId[]> {
		return this.applicationModel.distinct("listing", {
			_id: { $nin: await endedTenancyApplications(this.tenancyModel) },
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] }
		});
	}

	/** Let to a household, or past its availableUntil: same rule as the search lists. */
	async isClosed(listing: Pick<Listing, "_id" | "availableUntil">): Promise<boolean> {
		if (listing.availableUntil && new Date(listing.availableUntil).getTime() <= Date.now()) return true;
		return Boolean(await this.applicationModel.exists({
			listing: listing._id,
			_id: { $nin: await endedTenancyApplications(this.tenancyModel) },
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] }
		}));
	}

	async getAllVerifiedListings(): Promise<Listing[]> {
		const listings = await this.listingModel
			.find({ isVerified: true, isDraft: false, _id: { $nin: await this.letListingIds() }, $and: [stillAvailable()] })
			.select("-registerOfTitleKey -registrationNumber -likedBy")
			.exec();
		return listings;
	}

	/** Counts a public view of a published listing. Failures never block the page. */
	async recordView(id: string): Promise<void> {
		if (!Types.ObjectId.isValid(id)) return;
		await this.listingModel.updateOne({ _id: id }, { $inc: { views: 1 } }).exec().catch(() => undefined);
	}

	async findByLandlord(id: string): Promise<Listing[]> {
		return (await this.listingModel.find({ landlord: id }).exec()) ?? [];
	}

	async findListingById(id: string): Promise<Listing> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}
		const listing = await this.listingModel.findById(id).exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
		return listing;
	}

	/** The public fetch hides registrationNumber, so read just the compliance fields here. */
	async isComplianceComplete(id: string): Promise<boolean> {
		const doc = await this.listingModel.findById(id).select("registrationNumber epcRating epcExpiry eicrExpiry gasSafetyExpiry hmoLicenceExpiry bedroomsCount").lean();
		return !!doc && complianceComplete(doc);
	}

	async findPublishedListingById(id: string): Promise<Listing> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}
		const listing = await this.listingModel
			.findOne({
				_id: id,
				isVerified: true,
				isDraft: false
			})
			.select("-registerOfTitleKey -registrationNumber -likedBy")
			.exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
		return listing;
	}

	async likeListing(id: string, user: User): Promise<void> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}
		const listing = await this.listingModel
			.findOneAndUpdate(
				{ _id: id, isVerified: true, isDraft: false },
				{ $addToSet: { likedBy: user._id } }
			)
			.exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
	}

	async unlikeListing(id: string, user: User): Promise<void> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}
		const listing = await this.listingModel
			.findOneAndUpdate(
				{ _id: id, isVerified: true, isDraft: false },
				{ $pull: { likedBy: user._id } }
			)
			.exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
	}

	async getLiked(user: User): Promise<LikedListingsDto> {
		const listings = await this.listingModel
			.find({
				likedBy: user._id,
				isVerified: true,
				isDraft: false,
				_id: { $nin: await this.letListingIds() },
				$and: [stillAvailable()]
			})
			.select("-registerOfTitleKey -registrationNumber -likedBy")
			.exec();
		return {
			data: listings,
			total: listings.length
		};
	}

	/**
	 * Geocodes an address with Google when GOOGLE_GEOCODING_API_KEY is set.
	 * Without a key (local development) it returns null and the listing is
	 * published without a map position rather than failing.
	 */
	async getCoordinates(
		streetAddress: string,
		cityTown: string,
		postcode: string,
		country: string
	): Promise<{ formatted_address: string; lat: number; lng: number } | null> {
		const key = this.configService.get<string>("GOOGLE_GEOCODING_API_KEY");
		if (!key || key === "local-placeholder") {
			return null;
		}
		const address = `${streetAddress}, ${cityTown}, ${postcode}, ${country}`;
		const url = "https://maps.googleapis.com/maps/api/geocode/json";

		const res = await axios.get(url, { params: { address, key } });
		if (res.data.status !== "OK" || !res.data.results?.length) {
			throw new BadRequestException("Invalid address");
		}
		return {
			formatted_address: res.data.results[0].formatted_address,
			lat: res.data.results[0].geometry.location.lat,
			lng: res.data.results[0].geometry.location.lng
		};
	}

	async filters(filters: ListingFilterDto): Promise<ListingWithCoordinates[]> {
		const query: any = {
			isDraft: false,
			isVerified: true,
			_id: { $nin: await this.letListingIds() },
			// $and, so the text search's $or below does not replace it.
			$and: [stillAvailable()]
		};
		const toNumber = (value: unknown): number | undefined => {
			if (value === undefined || value === null || value === "") {
				return undefined;
			}

			const numberValue = Number(value);
			return Number.isFinite(numberValue) ? numberValue : undefined;
		};
		const isPositive = (value: number | undefined): value is number =>
			value !== undefined && value > 0;
		const lat = toNumber(filters.lat);
		const lng = toNumber(filters.lng);
		const radius = toNumber(filters.radius);
		const numOfPeople = toNumber(filters.numOfPeople);
		const monthlyRentMin = toNumber(filters.monthlyRentMin);
		const monthlyRentMax = toNumber(filters.monthlyRentMax);
		const sizeSqMeters = toNumber(filters.sizeSqMeters);
		const minLat = toNumber(filters.minLat);
		const maxLat = toNumber(filters.maxLat);
		const minLng = toNumber(filters.minLng);
		const maxLng = toNumber(filters.maxLng);
		const maxRent = toNumber(filters.maxRent);
		const minBedrooms = toNumber(filters.minBedrooms);
		const hasBox = [minLat, maxLat, minLng, maxLng].every(
			value => value !== undefined
		);

		if (hasBox) {
			// The visible map area. Takes precedence over a centre point, since
			// $geoWithin and $near cannot both apply to the same field.
			query.location = {
				$geoWithin: {
					$box: [
						[minLng, minLat],
						[maxLng, maxLat]
					]
				}
			};
		} else if (lat !== undefined && lng !== undefined) {
			query.location = {
				$near: {
					$geometry: {
						type: "Point",
						coordinates: [lng, lat]
					},
					// Nearest first; only cut off by distance when asked to.
					...(isPositive(radius) ? { $maxDistance: radius } : {})
				}
			};
		}

		if (filters.propertyType) {
			query.propertyType = filters.propertyType;
		}

		if (isPositive(numOfPeople)) {
			query.numOfPeople = { $gte: numOfPeople };
		}

		if (isPositive(monthlyRentMin) || isPositive(monthlyRentMax)) {
			query.monthlyRent = {};

			if (isPositive(monthlyRentMin)) {
				query.monthlyRent.$gte = monthlyRentMin;
			}

			if (isPositive(monthlyRentMax)) {
				query.monthlyRent.$lte = monthlyRentMax;
			}
		}

		if (isPositive(sizeSqMeters)) {
			query.sizeSqMeters = { $gte: sizeSqMeters };
		}

		if (filters.amenities && filters.amenities.length > 0) {
			query.amenities = { $all: filters.amenities };
		}

		if (isPositive(minBedrooms)) {
			query.bedroomsCount = { $gte: minBedrooms };
		}

		if (typeof filters.billsIncluded === "boolean") {
			query.billsIncluded = filters.billsIncluded
				? true
				: { $ne: true };
		}

		if (filters.city?.trim()) {
			query.cityTown = new RegExp(escapeRegExp(filters.city.trim()), "i");
		}

		if (filters.text?.trim()) {
			const pattern = new RegExp(escapeRegExp(filters.text.trim()), "i");
			query.$or = [
				{ propertyTitle: pattern },
				{ propertyDesc: pattern },
				{ streetAddress: pattern },
				{ cityTown: pattern },
				{ postcodeZIP: pattern },
				{ formatted_address: pattern }
			];
		}

		if (isPositive(maxRent)) {
			// Listing rent is the whole-property monthly rent; students compare
			// what they each pay, so divide by the number of occupants.
			query.$expr = {
				$lte: [
					{
						$divide: [
							"$monthlyRent",
							{ $max: [{ $ifNull: ["$numOfPeople", 1] }, 1] }
						]
					},
					maxRent
				]
			};
		}

		let results = this.listingModel
			.find(query)
			.select("-registerOfTitleKey -registrationNumber -likedBy");

		const limit = toNumber(filters.limit);
		if (isPositive(limit)) {
			const page = Math.max(1, toNumber(filters.page) ?? 1);
			// $near already orders by distance; otherwise page in a stable order.
			if (!query.location) {
				results = results.sort({ _id: -1 });
			}
			results = results.skip((page - 1) * limit).limit(limit);
		}

		const listings = await results.lean().exec();
		return listings.map(listing => withCoordinates(listing));
	}
}

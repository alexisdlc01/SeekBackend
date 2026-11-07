import {
	Injectable,
	forwardRef,
	Inject,
	BadRequestException,
	NotFoundException,
	UnauthorizedException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Listing, ViewingSlotAvailability } from "./listings.schema";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
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
import { listingDepositCompliance } from "../tenancies/compliance";
import {
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

export type ListingWithCoordinates = Listing & {
	lat: number | null;
	lng: number | null;
	rentPerPerson: number | null;
};

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
		private readonly applicationModel: Model<Application>
	) {}

	/** Places left per viewing slot: capacity minus open households already booked at that time. */
	async viewingSlotAvailability(listing: Pick<Listing, "_id" | "viewingSlots" | "viewingSlotCapacity">): Promise<ViewingSlotAvailability[]> {
		const slots = (listing.viewingSlots ?? []).map(slot => new Date(slot));
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
		if (data.availableFrom) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("isDraft availableFrom")
				.lean()
				.exec();
			// Drafts may hold any date until publish; a live listing may keep its date but not move it into the past.
			const moved = current?.availableFrom?.getTime() !== new Date(data.availableFrom).getTime();
			if (current && !current.isDraft && moved) assertAvailableFromNotPast(data.availableFrom);
		}
		if (data.criteria) update.criteria = normaliseCriteria(data.criteria);
		if (data.viewingSlots) update.viewingSlots = normaliseViewingSlots(data.viewingSlots as string[]);
		if (["holdingDeposit", "securityDeposit", "monthlyRent", "numOfPeople", "nation"].some(key => key in data)) {
			const current = await this.listingModel
				.findOne({ _id: new Types.ObjectId(listingId), landlord: new Types.ObjectId(landlord._id) })
				.select("monthlyRent numOfPeople securityDeposit holdingDeposit nation")
				.lean()
				.exec();
			// Deposit at most 5 weeks' rent (2 months in Scotland), holding deposit at most 1 week's per room.
			const overCap = listingDepositCompliance({ ...current, ...data, _id: new Types.ObjectId(listingId) } as never);
			if (overCap.length > 0) {
				throw new BadRequestException(overCap.map(item => item.message).join(" "));
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
			.select("isDraft availableFrom")
			.lean()
			.exec();
		if (draft?.isDraft && draft.availableFrom) assertAvailableFromNotPast(draft.availableFrom);
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

		await this.listingModel.deleteOne({ _id: listingId });
		this.listingsGateway.emitListingDeleted(listing);
		return { message: "Listing successfully deleted" };
	}

	async getAllUnverifiedListings(): Promise<Listing[]> {
		return (
			(await this.listingModel
				.find({ isVerified: false, isDraft: false })
				.sort({ createdAt: -1 })
				.exec()) ?? []
		);
	}

	/** Listings a household has already accepted: no longer open to applicants, so hidden from public search. */
	private async letListingIds(): Promise<Types.ObjectId[]> {
		return this.applicationModel.distinct("listing", {
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] }
		});
	}

	async getAllVerifiedListings(): Promise<Listing[]> {
		const listings = await this.listingModel
			.find({ isVerified: true, isDraft: false, _id: { $nin: await this.letListingIds() } })
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

	async verifyListing(id: string): Promise<Listing> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingModel
			.findByIdAndUpdate(id, { isVerified: true }, { new: true })
			.exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
		this.listingsGateway.emitListingUpdated(listing);
		return listing;
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
				isDraft: false
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
			_id: { $nin: await this.letListingIds() }
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

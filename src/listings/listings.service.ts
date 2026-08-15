import {
	Injectable,
	forwardRef,
	Inject,
	BadRequestException,
	NotFoundException,
	UnauthorizedException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Listing } from "./listings.schema";
import { Model, Types } from "mongoose";
import { CreateListingDto } from "./dto/create-listing.dto";
import { User } from "../users/users.schema";
import { ListingsGateway } from "./listings.gateway";
import { InvalidRequest } from "@aws-sdk/client-s3";
import { LikedListingsDto } from "./dto/liked-listings.dto";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { ListingFilterDto } from "./dto/listing-filter.dto";

type DraftUpdateData = Partial<CreateListingDto> & {
	location?: {
		type: "Point";
		coordinates: [number, number];
	};
	formatted_address?: string;
};

@Injectable()
export class ListingsService {
	constructor(
		@InjectModel(Listing.name)
		private readonly listingModel: Model<Listing>,
		private readonly listingsGateway: ListingsGateway,
		private readonly configService: ConfigService
	) {}

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
		const listing = await this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: { ...data, lastUpdated: new Date() } },
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

	async getAllVerifiedListings(): Promise<Listing[]> {
		const listings = await this.listingModel
			.find({ isVerified: true, isDraft: false })
			.select("-registerOfTitleKey -registrationNumber -likedBy")
			.exec();
		return listings;
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

	async getCoordinates(
		streetAddress: string,
		cityTown: string,
		postcode: string,
		country: string
	): Promise<{ formatted_address: string; lat: number; lng: number }> {
		const address = `${streetAddress}, ${cityTown}, ${postcode}, ${country}`;
		let url = "https://maps.googleapis.com/maps/api/geocode/json";

		const res = await axios.get(url, {
			params: {
				address,
				key: this.configService.get("GOOGLE_GEOCODING_API_KEY")
			}
		});
		if (res.data.status !== "OK" || !res.data.results?.length) {
			throw new BadRequestException("Invalid address");
		}
		return {
			formatted_address: res.data.results[0].formatted_address,
			lat: res.data.results[0].geometry.location.lat,
			lng: res.data.results[0].geometry.location.lng
		};
	}

	async filters(filters: ListingFilterDto): Promise<Listing[]> {
		const query: any = {
			isDraft: false,
			isVerified: true
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

		if (lat !== undefined && lng !== undefined) {
			query.location = {
				$near: {
					$geometry: {
						type: "Point",
						coordinates: [lng, lat]
					},
					$maxDistance: isPositive(radius) ? radius : 5000
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

		return this.listingModel
			.find(query)
			.select("-registerOfTitleKey -registrationNumber -likedBy")
			.exec();
	}
}

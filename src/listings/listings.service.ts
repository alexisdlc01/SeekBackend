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

@Injectable()
export class ListingsService {
	constructor(
		@InjectModel(Listing.name)
		private readonly listingModel: Model<Listing>,
		private readonly listingsGateway: ListingsGateway
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
		data: Partial<CreateListingDto>
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
		this.listingsGateway.emitListingDeleted(listingId);
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

	async likeListing(id: string, user: User): Promise<void> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid listing ID");
		}
		const listing = await this.listingModel
			.findByIdAndUpdate(id, {
				$addToSet: { likedBy: user._id }
			})
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
			.findByIdAndUpdate(id, {
				$pull: { likedBy: user._id }
			})
			.exec();
		if (!listing) {
			throw new NotFoundException("Listing not found");
		}
	}

	async getLiked(user: User): Promise<LikedListingsDto> {
		const listings = await this.listingModel
			.find({ likedBy: user._id })
			.exec();
		return {
			data: listings,
			total: listings.length
		};
	}
}

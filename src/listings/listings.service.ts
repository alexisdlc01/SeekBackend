import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Listing } from "./listings.schema";
import { Model, Types } from "mongoose";
import { CreateListingDto } from "./dto/create-listing.dto";
import { User } from "../users/users.schema";
import { ListingsGateway } from "./listings.gateway";

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
		this.listingsGateway.emitListingUpdated(newListing);
		return newListing._id.toString();
	}

	async updateDraft(
		listingId: string,
		landlord: User,
		data: Partial<CreateListingDto>
	): Promise<Listing | null> {
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
		return listing;
	}

	async publishDraft(
		listingId: string,
		landlord: User
	): Promise<Listing | null> {
		return this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: { isDraft: false, lastUpdated: new Date() } },
			{ new: true }
		);
	}

	async deleteListing(
		listingId: string,
		landlord: User
	): Promise<{ message: string }> {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new Error("Invalid listing ID");
		}

		const listing = await this.listingModel.findById(listingId);
		if (!listing) {
			throw new Error("Listing not found");
		}

		if (listing.landlord.toString() !== landlord._id.toString()) {
			throw new Error("Unauthorized: You do not own this listing");
		}

		await this.listingModel.deleteOne({ _id: listingId });
		this.listingsGateway.emitListingDeleted(listingId);
		return { message: "Listing successfully deleted" };
	}

	async getAllUnverifiedListings(): Promise<Listing[] | null> {
		return await this.listingModel
			.find({ isVerified: false, isDraft: false })
			.sort({ createdAt: -1 })
			.exec();
	}

	async findByLandlord(id: string): Promise<Listing[] | null> {
		return await this.listingModel.find({ landlord: id }).exec();
	}

	async verifyListing(id: string): Promise<Listing | null> {
		if (!Types.ObjectId.isValid(id)) {
			throw new Error("Invalid listing ID");
		}

		return await this.listingModel
			.findByIdAndUpdate(id, { isVerified: true }, { new: true })
			.exec();
	}

	async findListingById(id: string): Promise<Listing | null> {
		try {
			if (!Types.ObjectId.isValid(id)) {
				return null;
			}
			const listing = await this.listingModel.findById(id).exec();
			return listing || null;
		} catch (err) {
			console.error("Error fetching listing:", err.message);
			return null;
		}
	}
}

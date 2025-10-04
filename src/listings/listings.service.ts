import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Listing } from "./listings.schema";
import { Model, Types } from "mongoose";
import { CreateListingDto } from "./dto/create-listing.dto";
import { User } from "../users/users.schema";

@Injectable()
export class ListingsService {
	constructor(
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>
	) {}

	async createDraft(user: User): Promise<string> {
		const newListing: Listing = await this.listingModel.create({
			landlord: new Types.ObjectId(user._id),
			isDraft: true
		});
		return newListing._id.toString();
	}

	async updateDraft(
		listingId: string,
		landlord: User,
		data: Partial<CreateListingDto>
	) {
		return this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: { ...data, lastUpdated: new Date() } },
			{ new: true }
		);
	}

	async publishDraft(listingId: string, landlord: User) {
		return this.listingModel.findOneAndUpdate(
			{
				_id: new Types.ObjectId(listingId),
				landlord: new Types.ObjectId(landlord._id)
			},
			{ $set: { isDraft: false, lastUpdated: new Date() } },
			{ new: true }
		);
	}

	async findByLandlord(id: string) {
		return await this.listingModel.find({ landlord: id }).exec();
	}

	async verifyListing(id: string) {
		if (!Types.ObjectId.isValid(id)) {
			throw new Error("Invalid listing ID");
		}

		return await this.listingModel
			.findByIdAndUpdate(id, { isVerified: true }, { new: true })
			.exec();
	}

	async findListingById(id: string) {
		return (await this.listingModel.findById(id)) || null;
	}
}

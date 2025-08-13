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

	async create(body: CreateListingDto, user: User) {
		return await this.listingModel.create({
			...body,
			landlord: new Types.ObjectId(user._id)
		});
	}
}

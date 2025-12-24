import {
	BadRequestException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Application } from "./application.schema";
import { ListingsService } from "../listings/listings.service";
import { User } from "../users/users.schema";

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		private readonly listingService: ListingsService
	) {}

	async createApplication(listingId: string, user: User) {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingService.findListingById(listingId);

		return await this.applicationModel.create({
			listing: listing._id,
			landlord: listing.landlord,
			applicants: [user._id]
		});
	}

	async findApplicationById(id: string) {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application = await this.applicationModel.findById(id).exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		return application;
	}
}

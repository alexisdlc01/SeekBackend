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
import { ConfigService } from "@nestjs/config";

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		private readonly listingService: ListingsService,
		private readonly configService: ConfigService
	) {}

	async createApplication(
		listingId: string,
		user: User
	): Promise<Application> {
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

	async getAllMyApplications(userId: string): Promise<Application[] | null> {
		return await this.applicationModel
			.find({ applicants: userId })
			.populate("listing")
			.populate("landlord", "name email")
			.sort({ createdAt: -1 })
			.exec();
	}

	async findApplicationById(id: string): Promise<Application> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application: Application | null = await this.applicationModel
			.findById(id)
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		return application;
	}

	async getShareLinkForApplication(id: string): Promise<string> {
		const application: Application | null =
			await this.applicationModel.findById(id);

		if (!application) {
			throw new BadRequestException("Invalid application id");
		}
		return `${this.configService.get("BACKEND_URL")}/application/${application._id.toString()}/join`;
	}

	async joinApplication(
		applicationId: string,
		userId: string
	): Promise<Application> {
		const application: Application | null =
			await this.applicationModel.findById(applicationId);

		if (!application) {
			throw new BadRequestException("Invalid application id");
		}

		const updatedApplication: Application | null =
			await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId },
				{ $addToSet: { applicants: new Types.ObjectId(userId) } },
				{ new: true }
			);

		if (!updatedApplication) {
			throw new NotFoundException("Application not found");
		}

		return updatedApplication;
	}
}

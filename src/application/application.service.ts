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
import { ApplicationStage } from "./enums/application-stage.enum";
import { Conversation } from "src/conversation/converstaion.schema";
import { UsersRepository } from "src/users/users.repository";

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		@InjectModel(Conversation.name)
		private readonly converstaionModel: Model<Conversation>,
		private readonly listingService: ListingsService,
		private readonly userSevice: UsersRepository,
	) { }

	async create(
		listingId: string,
		user: User
	): Promise<Application> {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingService.findListingById(listingId);
		if (!listing) {
			throw new NotFoundException("Listing not found.");
		}

		const conversation = await this.converstaionModel.create({
			name: `${user.name}'s application to ${listing.propertyTitle}`,
			createdBy: user._id,
			users: [user._id]
		});

		return await this.applicationModel.create({
			listing: listing._id,
			landlord: listing.landlord,
			applicants: [user._id],
			conversation: conversation._id,
			owner: user._id
		});
	}

	async changeOwner(
		applicationId: string,
		newOwner: string
	): Promise<void> {
		const user = this.userSevice.getUserById(newOwner);
		if (!user) {
			throw new NotFoundException("no such user exists for transfer.");
		}

		const result = await this.applicationModel.updateOne({
			_id: applicationId
		}, {
			owner: newOwner
		}).exec();
		if (result.modifiedCount === 0) {
			throw new NotFoundException("no such user exists for the transfer.");
		}
	}

	async delete(
		applicationId: string,
	): Promise<void> {
		await this.applicationModel.deleteOne({
			_id: applicationId
		});
	}

	async getAllMyApplications(userId: string): Promise<Application[]> {
		return await this.applicationModel
			.find({ applicants: userId })
			.populate("listing")
			.populate("conversation")
			.sort({ createdAt: -1 })
			.exec() ?? [];
	}

	async getAllByListing(listingId: string): Promise<Application[]> {
		return await this.applicationModel
			.find({
				listing: listingId,
				$or: [{
					stage: ApplicationStage.SENT,
				},
				{
					stage: ApplicationStage.REJECTED,
				}, {
					stage: ApplicationStage.ACCEPTED,
				}]
			})
			.sort({ createdAt: -1 })
			.exec() ?? [];
	}

	async approve(applicationId: string): Promise<void> {
		await this.applicationModel
			.updateOne({
				_id: applicationId,
			}, {
				stage: ApplicationStage.ACCEPTED
			})
			.exec();
	}

	async reject(applicationId: string): Promise<void> {
		await this.applicationModel
			.updateOne({
				_id: applicationId,
			}, {
				stage: ApplicationStage.REJECTED
			})
			.exec();
	}

	async send(applicationId: string): Promise<void> {
		await this.applicationModel
			.updateOne({
				_id: applicationId,
			}, {
				stage: ApplicationStage.SENT
			})
			.exec();
	}

	async findApplicationById(id: string): Promise<Application> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application = await this.applicationModel
			.findById(id)
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		return application;
	}

	async join(
		applicationId: string,
		userId: string
	): Promise<void> {
		const application: Application | null =
			await this.applicationModel.findById(applicationId);

		if (!application) {
			throw new BadRequestException("Invalid application id");
		}

		if (application.stage !== ApplicationStage.NOT_SENT) {
			throw new BadRequestException("Application already sent.");
		}

		const updatedApplication: Application | null =
			await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId },
				{ $addToSet: { applicants: new Types.ObjectId(userId) } },
			);

		if (!updatedApplication) {
			throw new NotFoundException("Application not found");
		}
	}

	async sendApplication(applicationId: string): Promise<void> {
		const application: Application | null =
			await this.applicationModel.findById(applicationId);
		if (!application) {
			throw new BadRequestException("Invalid application id");
		}
		if (application.stage === ApplicationStage.NOT_SENT) {
			await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId },
				{ $set: { stage: ApplicationStage.SENT } },
				{ new: true }
			);
		} else {
			throw new BadRequestException("Application already send.");
		}
	}
}

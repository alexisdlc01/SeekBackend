import {
	BadRequestException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { HydratedDocument, Model, Types } from "mongoose";
import { Application } from "./application.schema";
import { ListingsService } from "../listings/listings.service";
import { User } from "../users/users.schema";
import { ApplicationStage } from "./enums/application-stage.enum";
import { Conversation } from "../conversation/converstaion.schema";
import { UsersRepository } from "../users/users.repository";
import { ApplicationDto } from "./dto/application.dto";
import { plainToInstance } from "class-transformer";
import { DocumentType } from "../users/types/document-type";
import { ConversationAccessService } from "../conversation/conversation-access.service";

const REQUIRED_DOCUMENT_RULES: {
	type: DocumentType;
	label: string;
	pattern: RegExp;
}[] = [
	{
		type: DocumentType.IDENTIFICATION,
		label: "Identification",
		pattern: /identification|passport|national id/i,
	},
	{
		type: DocumentType.PROOF_OF_INCOME,
		label: "Proof of income",
		pattern: /proof of income|financial support|student loan|scholarship|savings/i,
	},
	{
		type: DocumentType.GUARANTOR_AGREEMENT,
		label: "Guarantor agreement",
		pattern: /guarantor/i,
	},
	{
		type: DocumentType.LANDLORD_REFERENCE,
		label: "Landlord reference",
		pattern: /landlord reference|accommodation (letter|reference)/i,
	},
	{
		type: DocumentType.CHARACTER_REFERENCE,
		label: "Character reference",
		pattern: /character reference/i,
	},
];

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		@InjectModel(Conversation.name)
		private readonly converstaionModel: Model<Conversation>,
		private readonly listingService: ListingsService,
		private readonly userSevice: UsersRepository,
		private readonly conversationAccessService: ConversationAccessService,
	) { }

	async create(
		listingId: string,
		user: User
	): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingService.findPublishedListingById(listingId);

		const applicationKey = `${listing._id.toString()}:${user._id.toString()}`;
		const existingApplication = await this.applicationModel
			.findOne({
				$or: [
					{ applicationKey },
					{ listing: listing._id, owner: user._id },
				]
			})
			.exec();
		if (existingApplication) {
			return this.toDto(existingApplication);
		}

		this.assertRequiredDocuments(listing.requirements ?? [], user);

		const conversation = await this.converstaionModel.create({
			name: `${user.name}'s application to ${listing.propertyTitle}`,
			createdBy: user._id,
			users: [user._id]
		});

		try {
			const application = await this.applicationModel.create({
				listing: listing._id,
				landlord: listing.landlord,
				applicants: [user._id],
				conversation: conversation._id,
				owner: user._id,
				applicationKey,
			});
			return this.toDto(application);
		} catch (error) {
			// If two requests raced, the unique application key chooses the winner.
			// Remove only this request's unused conversation and return the winner.
			if (this.isDuplicateKeyError(error)) {
				await this.converstaionModel.deleteOne({ _id: conversation._id });
				const existing = await this.applicationModel
					.findOne({ applicationKey })
					.exec();
				if (existing) return this.toDto(existing);
			}

			await this.converstaionModel.deleteOne({ _id: conversation._id });
			throw error;
		}
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

	async getAllMyApplications(userId: string): Promise<ApplicationDto[]> {
		const applications = await this.applicationModel
			.find({ applicants: userId })
			.populate({
				path: "listing",
				select: "-registerOfTitleKey -registrationNumber -likedBy",
			})
			.populate({
				path: "conversation",
				populate: {
					path: "lastMessage",
				}
			})
			.sort({ createdAt: -1 })
			.exec() ?? [];
		// Hide legacy duplicates from the client. New records are protected by the
		// applicationKey unique index, so this only affects pre-existing data.
		const seenListings = new Set<string>();
		return applications
			.filter(application => {
				const listing = application.listing as any;
				const listingId = listing?._id?.toString?.() ?? listing?.toString?.();
				if (!listingId || seenListings.has(listingId)) return false;
				seenListings.add(listingId);
				return true;
			})
			.map(application => this.toDto(application));
	}

	async getAllByListing(listingId: string): Promise<ApplicationDto[]> {
		const applications = await this.applicationModel
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
		return applications.map(application => this.toDto(application));
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
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: ApplicationStage.NOT_SENT,
			}, {
				$set: { stage: ApplicationStage.SENT }
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("Application has already been sent.");
		}

		await this.converstaionModel.updateOne(
			{ _id: application.conversation },
			{ $addToSet: { users: application.landlord } }
		).exec();
	}

	async findApplicationById(id: string): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application = await this.applicationModel
			.findById(id)
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		return this.toDto(application);
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

		await this.converstaionModel.updateOne(
			{ _id: application.conversation },
			{ $addToSet: { users: new Types.ObjectId(userId) } }
		).exec();
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

	async getByConversation(
		conversationId: string,
		userId: string,
	): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(conversationId)) {
			throw new BadRequestException("Invalid conversation ID");
		}
		const application = await this.applicationModel
			.findOne({ conversation: conversationId })
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		await this.conversationAccessService.assertCanAccess(
			conversationId,
			userId,
		);
		return this.toDto(application);
	}

	private toDto(application: HydratedDocument<Application>): ApplicationDto {
		const value = application.toObject() as unknown as Record<string, unknown>;
		if (
			value.listing &&
			typeof value.listing === "object" &&
			!Array.isArray(value.listing) &&
			!(value.listing instanceof Types.ObjectId)
		) {
			const safeListing = {
				...(value.listing as Record<string, unknown>),
			};
			delete safeListing.registerOfTitleKey;
			delete safeListing.registrationNumber;
			delete safeListing.likedBy;
			value.listing = safeListing;
		}
		return plainToInstance(ApplicationDto, value, {
			excludeExtraneousValues: true,
		});
	}

	private assertRequiredDocuments(
		requirements: { name: string; desc: string; required: boolean }[],
		user: User,
	): void {
		const uploadedDocuments = new Set(
			(user.documents ?? []).map(document => document.type),
		);
		const missingDocuments = REQUIRED_DOCUMENT_RULES.filter(rule =>
			requirements.some(requirement =>
				requirement.required &&
				rule.pattern.test(`${requirement.name ?? ""} ${requirement.desc ?? ""}`),
			),
		)
			.filter(rule => !uploadedDocuments.has(rule.type))
			.map(rule => rule.label);

		if (missingDocuments.length > 0) {
			throw new BadRequestException(
				`Missing required documents: ${missingDocuments.join(", ")}`,
			);
		}
	}

	private isDuplicateKeyError(error: unknown): error is { code: number } {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: number }).code === 11000
		);
	}
}

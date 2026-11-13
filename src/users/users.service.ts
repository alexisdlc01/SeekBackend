import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, UpdateQuery } from "mongoose";
import { User } from "./users.schema";
import { CreateUserDto } from "./dto/create-user.dto";
import { hash } from "bcryptjs";
import { GoogleUserDto } from "../auth/dto/google-user.dto";
import { DocumentStatus, DocumentType, IDENTITY_DOCUMENT_TYPES } from "./types/document-type";
import { buildPassport, Passport } from "./passport";
import { plainToInstance } from "class-transformer";
import { UserDto } from "./dto/user.dto";
import { UsersRepository } from "./users.repository";
import { DocumentTypesDto } from "./dto/provided-docs.dto";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";
import { Role } from "../auth/role.enum";
import { isKeyOwnedBy } from "../upload/object-key";
import { MailService } from "../auth/mail.service";
import { RequestReferenceDto } from "./dto/passport.dto";
import { PendingDocumentDto } from "./dto/pending-document.dto";
import { UploadService } from "../upload/upload.service";
import { DocumentReviewService } from "./document-review.service";

const REFERENCE_ASK = "Could you write a short reference about them as a tenant (dates, whether rent was paid on time, how they looked after the property)? Please attach it to your reply as a PDF.";

/** Subject and ask for each request. Reference subjects contain "reference" so a connected inbox files the reply. */
const REFERENCE_EMAILS: Record<RequestReferenceDto["type"], (student: string) => { subject: string; ask: string }> = {
	[DocumentType.GUARANTOR_AGREEMENT]: student => ({
		subject: `${student} asked you to be their UK guarantor`,
		ask: `Would you be ${student}'s UK guarantor? A guarantor agrees to pay the rent if the tenant can't. If you agree, reply to say so and the landlord will send you the guarantor agreement to sign.`
	}),
	[DocumentType.LANDLORD_REFERENCE]: student => ({ subject: `Landlord reference for ${student}`, ask: REFERENCE_ASK }),
	[DocumentType.AGENT_REFERENCE]: student => ({ subject: `Letting agent reference for ${student}`, ask: REFERENCE_ASK }),
	[DocumentType.RECOMMENDATION]: student => ({
		subject: `Character reference for ${student}'s housing application`,
		ask: "Could you write a short character reference for their housing application? Please attach it to your reply as a PDF."
	})
};

@Injectable()
class UsersService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly userRepo: UsersRepository,
		private readonly mailService: MailService,
		private readonly uploads?: UploadService,
		private readonly review?: DocumentReviewService
	) { }

	private readonly logger = new Logger(UsersService.name);

	async create(data: CreateUserDto) {
		try {
			const result = await new this.userModel({
				name: data.name.trim(),
				email: data.email.trim().toLowerCase(),
				role: data.role ?? Role.STUDENT,
				profilePicUrl: data.imageUrl,
				isVerified: true,
				password: await hash(data.password, 12)
			}).save();

			return plainToInstance(UserDto, result.toObject(), {
				excludeExtraneousValues: true
			});
		} catch (err) {
			if (err.code === 11000 && err.keyPattern?.email) {
				throw new ConflictException("Email already in use.");
			}
			throw err;
		}
	}

	async createGoogleUser(data: GoogleUserDto) {
		const result = await new this.userModel({
			...data
		}).save();
		return plainToInstance(UserDto, result.toObject(), {
			excludeExtraneousValues: true
		});
	}

	async getUserById(id: string) {
		const result = await this.userRepo.getUserById(id);
		if (!result) {
			throw new NotFoundException("User not found.");
		}

		return plainToInstance(UserDto, result, {
			excludeExtraneousValues: true
		});
	}

	async getUserByEmail(email: string) {
		const result = await this.userRepo.getUserByEmail(email);
		if (!result) {
			throw new NotFoundException("User not found.");
		}
		return plainToInstance(UserDto, result, {
			excludeExtraneousValues: true
		});
	}

	async getUserForSession(userId: string, sessionId: string) {
		const user = await this.userRepo.getUserById(userId);
		const activeSession = user?.refreshSessions?.some(
			session =>
				session.sessionId === sessionId && session.expiresAt > new Date()
		);
		// Suspended too: socket revalidation goes through here, so an open socket is cut at the next check.
		if (!user || !activeSession || user.suspendedAt) {
			throw new NotFoundException("Session not found.");
		}
		return user;
	}



	async setProfilePic(url: string, user: User) {
		const updated = await this.userModel.findByIdAndUpdate(
			user._id,
			{ $set: { profilePicUrl: url } },
			{ new: true, upsert: false }
		);

		if (!updated) {
			throw new NotFoundException("User not found.");
		}

		return plainToInstance(UserDto, updated.toObject(), {
			excludeExtraneousValues: true
		});
	}

	/**
	 * Documents checked against the old name are checked again against the new one: VERIFIED ones,
	 * so a student cannot borrow a name to verify someone else's document, and REJECTED ones, since
	 * a name mismatch tells the student to correct the name (the 20-a-day review limit bounds the cost).
	 */
	private async recheckDocumentsIfRenamed(userId: User["_id"] | string, name: string): Promise<void> {
		const checked = { type: { $nin: IDENTITY_DOCUMENT_TYPES }, status: { $in: [DocumentStatus.VERIFIED, DocumentStatus.REJECTED] } };
		await this.userModel.updateOne(
			{ _id: userId, name: { $ne: name }, documents: { $elemMatch: checked } },
			{ $set: { "documents.$[doc].status": DocumentStatus.PENDING, "documents.$[doc].rejectionReason": null, "documents.$[doc].reviewAttempts": 0, "documents.$[doc].lastReviewAt": null } },
			{ arrayFilters: [{ "doc.type": checked.type, "doc.status": checked.status }] }
		);
	}

	async setUsername(newName: string, user: User) {
		await this.recheckDocumentsIfRenamed(user._id, newName);
		const updated = await this.userModel.findByIdAndUpdate(
			user._id,
			{ $set: { name: newName } },
			{ new: true, upsert: false }
		);

		if (!updated) {
			throw new NotFoundException("User not found.");
		}

		return plainToInstance(UserDto, updated.toObject(), {
			excludeExtraneousValues: true
		});
	}

	async updateProfile(userId: string, data: UpdateUserProfileDto, role?: Role) {
		const set: Record<string, unknown> = {};
		const unset: Record<string, 1> = {};
		const isLandlord = role === Role.LANDLORD_AGENCY;

		if (
			!isLandlord &&
			(data.companyName !== undefined ||
				data.registrations !== undefined ||
				data.stripeAccountId !== undefined)
		) {
			throw new BadRequestException(
				"Company name, registrations and payouts are only available to landlords."
			);
		}

		if (data.companyName !== undefined) {
			const companyName = data.companyName.trim();
			if (companyName.length === 0) unset.companyName = 1;
			else set.companyName = companyName;
		}

		if (data.stripeAccountId !== undefined) {
			if (data.stripeAccountId === "") unset.stripeAccountId = 1;
			else set.stripeAccountId = data.stripeAccountId;
		}

		if (data.registrations !== undefined) {
			// Verification is done by Seek, so a landlord editing the list keeps
			// the verified flag only on numbers that did not change.
			const current = await this.userModel
				.findById(userId, { registrations: 1 })
				.lean()
				.exec();
			const verified = new Set(
				(current?.registrations ?? [])
					.filter(registration => registration.verified)
					.map(registration => `${registration.kind}:${registration.number}`)
			);
			set.registrations = data.registrations.map(registration => {
				const number = registration.number.trim();
				return {
					kind: registration.kind,
					number,
					verified: verified.has(`${registration.kind}:${number}`)
				};
			});
		}

		if (data.notificationPrefs) {
			for (const [key, value] of Object.entries(data.notificationPrefs)) {
				if (value !== undefined) set[`notificationPrefs.${key}`] = value;
			}
		}

		if (data.name !== undefined) {
			set.name = data.name.trim();
			await this.recheckDocumentsIfRenamed(userId, data.name.trim());
		}

		const optionalTextFields = [
			"username",
			"phone",
			"universityDetails"
		] as const;
		for (const field of optionalTextFields) {
			const value = data[field];
			if (value === undefined) continue;

			const normalized = value.trim();
			if (normalized.length === 0) {
				unset[field] = 1;
			} else {
				set[field] = field === "username"
					? normalized.toLowerCase()
					: normalized;
			}
		}

		if (data.dateOfBirth !== undefined) {
			if (data.dateOfBirth === "") {
				unset.dateOfBirth = 1;
			} else {
				set.dateOfBirth = new Date(data.dateOfBirth);
			}
		}

		const update: UpdateQuery<User> = {};
		if (Object.keys(set).length > 0) update.$set = set;
		if (Object.keys(unset).length > 0) update.$unset = unset;

		try {
			const updated = await this.userModel.findByIdAndUpdate(userId, update, {
				new: true,
				runValidators: true,
				upsert: false
			});

			if (!updated) {
				throw new NotFoundException("User not found.");
			}

			return plainToInstance(UserDto, updated.toObject(), {
				excludeExtraneousValues: true
			});
		} catch (error) {
			if (error?.code === 11000) {
				if (error.keyPattern?.username) {
					throw new ConflictException("Username already in use.");
				}
				if (error.keyPattern?.email) {
					throw new ConflictException("Email already in use.");
				}
			}
			throw error;
		}
	}

	async getAllUsers() {
		const users = await this.userModel.find({}).exec();
		return users.map(user => plainToInstance(UserDto, user.toObject(), {
			excludeExtraneousValues: true
		}));
	}

	async updateUser(query: FilterQuery<User>, data: UpdateQuery<User>) {
		const update = await this.userModel.findOneAndUpdate(query, data);
		if (!update) {
			throw new NotFoundException("User not found.");
		}

		return plainToInstance(UserDto, update.toObject(), {
			excludeExtraneousValues: true
		});
	}

	async addDocument(
		userId: string,
		documentType: DocumentType,
		url: string,
		key: string,
		extras: { label?: string; expiresAt?: string } = {}
	) {
		// Document access is resolved by looking up who holds a key, so a user
		// must not be able to record a key that was issued to somebody else.
		// Only keys minted for this user by the presign endpoint are accepted.
		if (!isKeyOwnedBy(key, userId)) {
			throw new BadRequestException(
				"Document key was not issued to this account."
			);
		}
		// The AI review only opens private/ keys; a public/ key would be rejected later as unreadable.
		if (!key.startsWith("private/")) {
			throw new BadRequestException("Documents must be uploaded privately.");
		}

		const result = await this.userModel.bulkWrite([
			{
				updateOne: {
					filter: { _id: userId },
					update: { $pull: { documents: { type: documentType } } }
				}
			},
			{
				updateOne: {
					filter: { _id: userId },
					update: {
						$push: {
							documents: {
								type: documentType,
								url,
								key,
								// Identity: the landlord checks it through the share. Anything else: the automatic review below.
								status: IDENTITY_DOCUMENT_TYPES.includes(documentType) ? DocumentStatus.PROVIDED : DocumentStatus.PENDING,
								label: extras.label?.trim() || undefined,
								expiresAt: extras.expiresAt ? new Date(extras.expiresAt) : null,
								uploadedAt: new Date()
							}
						}
					}
				}
			}
		])

		if (result.matchedCount === 0) {
			throw new BadRequestException(
				`Document ${documentType} already exists`
			);
		}
		// Not awaited: the upload answers now, the passport row updates when the review ends.
		if (!IDENTITY_DOCUMENT_TYPES.includes(documentType)) void this.review?.review(userId, documentType);

		return {
			message: "Document added successfully",
			documentType,
			url
		};
	}

	async getPassport(userId: string): Promise<Passport> {
		const user = await this.userModel
			.findById(userId, { documents: 1, studentVerifiedAt: 1, universityEmail: 1, referenceRequests: 1 })
			.lean()
			.exec();
		if (!user) {
			throw new NotFoundException("User not found.");
		}
		return buildPassport(user.documents, new Date(), user);
	}

	/** Seek emails a guarantor or referee; the passport row reads "pending" until a document arrives. */
	async requestReference(user: User, body: RequestReferenceDto): Promise<Passport> {
		const email = body.email.trim().toLowerCase();
		if (email === user.email?.toLowerCase()) {
			throw new BadRequestException("Ask someone else: this is your own email address.");
		}
		const referee = { name: body.name.trim(), email };
		const { subject, ask } = REFERENCE_EMAILS[body.type](user.name);
		// Send first, so the passport never says "invite sent" for an email that didn't go.
		try {
			await this.mailService.sendReferenceRequest(referee, { name: user.name, email: user.email }, subject, ask);
		} catch (error) {
			this.logger.error(`Reference request email failed: ${(error as Error).message}`);
			throw new ServiceUnavailableException("We couldn't send the email. Try again in a few minutes.");
		}
		// One request per type: asking again replaces the previous one.
		await this.userModel.updateOne({ _id: user._id }, { $pull: { referenceRequests: { type: body.type } } });
		await this.userModel.updateOne({ _id: user._id }, {
			$push: { referenceRequests: { type: body.type, ...referee, requestedAt: new Date() } }
		});
		return this.getPassport(user._id.toString());
	}

	/**
	 * Staff can only re-run the automatic check (status PENDING): no person verifies or rejects a
	 * document, and identity documents are never checked by Seek (the landlord checks them).
	 */
	async setDocumentStatus(userId: string, documentType: DocumentType, status: DocumentStatus) {
		if (IDENTITY_DOCUMENT_TYPES.includes(documentType)) {
			throw new BadRequestException("Seek does not check identity documents: they are provided, and the landlord checks them.");
		}
		if (status !== DocumentStatus.PENDING) {
			throw new BadRequestException("Documents are checked automatically. Send PENDING to run the check again.");
		}
		const result = await this.userModel.updateOne(
			{ _id: userId, "documents.type": documentType },
			{ $set: { "documents.$.status": DocumentStatus.PENDING, "documents.$.rejectionReason": null, "documents.$.reviewAttempts": 0, "documents.$.lastReviewAt": null } }
		);
		if (result.matchedCount === 0) {
			throw new NotFoundException("Document not found for this user.");
		}
		await this.review?.review(userId, documentType);
		return this.getPassport(userId);
	}

	/** Monitoring only (no one acts on it): every PENDING upload, oldest first, with a short-lived signed link. */
	async listPendingDocuments(): Promise<PendingDocumentDto[]> {
		const users = await this.userModel
			.find(
				{ deletedAt: null, documents: { $elemMatch: { status: DocumentStatus.PENDING } } },
				{ name: 1, email: 1, documents: 1 }
			)
			.lean()
			.exec();
		const pending = users.flatMap(user =>
			(user.documents ?? [])
				.filter(doc => doc.status === DocumentStatus.PENDING)
				.map(doc => ({ user, doc }))
		);
		pending.sort((a, b) => new Date(a.doc.uploadedAt ?? 0).getTime() - new Date(b.doc.uploadedAt ?? 0).getTime());
		return Promise.all(
			pending.map(async ({ user, doc }) => ({
				userId: user._id.toString(),
				name: user.name ?? null,
				email: user.email,
				type: doc.type,
				uploadedAt: doc.uploadedAt ?? null,
				// Only private-bucket keys are signed; never hand out the stored public-style URL.
				url: doc.key?.startsWith("private/") && this.uploads
					? await this.uploads.getPresignedDownloadUrl(doc.key, "private", 600) // staff open these minutes after the list loads
					: null
			}))
		);
	}

	async documentTypes(user: User): Promise<DocumentTypesDto> {
		return {
			data: (user.documents ?? []).map(el => el.type),
		}
	}
}

export default UsersService

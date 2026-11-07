import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, UpdateQuery } from "mongoose";
import { User } from "./users.schema";
import { CreateUserDto } from "./dto/create-user.dto";
import { hash } from "bcryptjs";
import { GoogleUserDto } from "../auth/dto/google-user.dto";
import { DocumentStatus, DocumentType } from "./types/document-type";
import { buildPassport, Passport } from "./passport";
import { plainToInstance } from "class-transformer";
import { UserDto } from "./dto/user.dto";
import { UsersRepository } from "./users.repository";
import { DocumentTypesDto } from "./dto/provided-docs.dto";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";
import { Role } from "../auth/role.enum";
import { isKeyOwnedBy } from "../upload/object-key";

@Injectable()
class UsersService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly userRepo: UsersRepository
	) { }

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
		if (!user || !activeSession) {
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

	async setUsername(newName: string, user: User) {
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
								// A new upload always waits for Seek to verify it.
								status: DocumentStatus.PENDING,
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

		return {
			message: "Document added successfully",
			documentType,
			url
		};
	}

	async getPassport(userId: string): Promise<Passport> {
		const user = await this.userModel
			.findById(userId, { documents: 1 })
			.lean()
			.exec();
		if (!user) {
			throw new NotFoundException("User not found.");
		}
		return buildPassport(user.documents);
	}

	/** Seek staff record the outcome of a document check. */
	async setDocumentStatus(
		userId: string,
		documentType: DocumentType,
		status: DocumentStatus,
		expiresAt?: string | null
	) {
		const set: Record<string, unknown> = { "documents.$.status": status };
		if (expiresAt !== undefined) {
			set["documents.$.expiresAt"] = expiresAt ? new Date(expiresAt) : null;
		}
		const result = await this.userModel.updateOne(
			{ _id: userId, "documents.type": documentType },
			{ $set: set }
		);
		if (result.matchedCount === 0) {
			throw new NotFoundException("Document not found for this user.");
		}
		return this.getPassport(userId);
	}

	async documentTypes(user: User): Promise<DocumentTypesDto> {
		return {
			data: (user.documents ?? []).map(el => el.type),
		}
	}
}

export default UsersService

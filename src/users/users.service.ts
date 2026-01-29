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
import { DocumentType } from "./types/document-type";
import { plainToInstance } from "class-transformer";
import { UserDto } from "./dto/user.dto";
import { UsersRepository } from "./users.repository";

@Injectable()
class UsersService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly userRepo: UsersRepository
	) { }

	async create(data: CreateUserDto) {
		try {
			const result = await new this.userModel({
				...data,
				password: await hash(data.password, 10)
			}).save();

			return plainToInstance(UserDto, result.toObject(), {
				excludeExtraneousValues: true
			});
		} catch (err) {
			if (err.code === 11000 && err.keyPattern?.email) {
				throw new ConflictException("Email already in use.");
			}
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

	async addDocument(userId: string, documentType: DocumentType, url: string) {
		const result = await this.userModel.updateOne(
			{
				_id: userId,
				"documents.type": { $ne: documentType }
			},
			{
				$push: {
					documents: {
						type: documentType,
						url
					}
				}
			}
		);

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
}

export default UsersService

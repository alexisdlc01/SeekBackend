import {
	ConflictException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, UpdateQuery } from "mongoose";
import { User } from "./users.schema";
import { CreateUserDto } from "./dtos/create-user.dto";
import { hash } from "bcryptjs";

@Injectable()
export class UsersService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>
	) {}

	async create(data: CreateUserDto) {
		try {
			const userDoc = await new this.userModel({
				...data,
				password: await hash(data.password, 10)
			}).save();
			return userDoc.toObject() as User;
		} catch (err) {
			if (err.code === 11000 && err.keyPattern?.email) {
				throw new ConflictException("Email already in use.");
			}
		}
	}

	async getUser(query: FilterQuery<User>) {
		const user = (await this.userModel.findOne(query))?.toObject();
		if (!user) {
			throw new NotFoundException("User not found.");
		}
		return user;
	}

	async getAllUsers() {
		return this.userModel.find({});
	}

	async updateUser(query: FilterQuery<User>, data: UpdateQuery<User>) {
		return this.userModel.findOneAndUpdate(query, data);
	}
}

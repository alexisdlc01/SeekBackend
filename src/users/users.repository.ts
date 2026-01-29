import { ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "./users.schema";
import { Model } from "mongoose";
import { CreateUserDto } from "./dto/create-user.dto";



@Injectable()
export class UsersRepository {
	constructor(@InjectModel(User.name) private readonly userModel: Model<User>) { }

	async getUserById(id: string): Promise<User | null> {
		return await this.userModel.findById(id);
	}

	async getUserByEmail(email: string): Promise<User | null> {
		return await this.userModel.findOne({
			email,
		});
	}

	async create(data: CreateUserDto): Promise<User | null> {
		try {
			return await this.userModel.create(data);
		} catch (err) {
			if (err.code === 11000 && err.keyPattern?.email) {
				throw new ConflictException("Email already in use.");
			}
			return null;
		}
	}

	async createPaswordless(data: Omit<CreateUserDto, "password">): Promise<User | null> {
		return await this.userModel.create(data);
	}
}


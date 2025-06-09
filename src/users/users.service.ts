import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { User } from "./users.schema";
import { CreateUserDto } from "./dtos/create-user.dto";
import { hash } from "bcryptjs";

@Injectable()
export class UsersService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>
	) {}

	async create(data: CreateUserDto) {
		await new this.userModel({
			...data,
			password: await hash(data.password, 10)
		}).save();
	}
}

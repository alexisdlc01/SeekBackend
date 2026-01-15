import {
	BadRequestException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { CreateFlagDto } from "./dto/create-flag.dto";
import { ResolveFlagDto } from "./dto/resolve-flag.dto";
import { Flag } from "./flags.schema";
import { Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "src/users/users.schema";
import { FlagStatus } from "./enums/flag-status";

@Injectable()
export class FlagsService {
	constructor(
		@InjectModel(Flag.name)
		private readonly flagModel: Model<Flag>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>
	) {}

	async create(createFlagDto: CreateFlagDto, user: User): Promise<Flag> {
		if (!Types.ObjectId.isValid(createFlagDto.reportedUser)) {
			throw new BadRequestException("Invalid reported user ID");
		}

        // Check if the reported user exists
		const reported = await this.userModel
			.exists({
				_id: createFlagDto.reportedUser
			})
			.exec();
		if (!reported) {
			throw new NotFoundException("User not found");
		}

        // Create the flag
		const flag = await this.flagModel.create({
			text: createFlagDto.text,
			category: createFlagDto.category,
			reportedUser: createFlagDto.reportedUser,
			createdBy: user._id,
			status: FlagStatus.UNDER_REVIEW
		});
		return flag.toObject();
	}

	async findOne(id: string): Promise<Flag> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid flag ID");
		}

		const flag = await this.flagModel.findById(id).exec();
		if (!flag) {
			throw new NotFoundException("Flag not found");
		}
		return flag;
	}

	async resolve(id: number, resolveFlagDto: ResolveFlagDto): Promise<Flag> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid flag ID");
		}

		const result = await this.flagModel
			.findByIdAndUpdate(id, {
				$set: {
					status: resolveFlagDto.status
				}
			})
			.exec();
		if (!result) {
			throw new NotFoundException("Flag not found");
		}
		return result.toObject();
	}
}

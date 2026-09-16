import {
	BadRequestException,
	ForbiddenException,
	Injectable,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Conversation } from "./converstaion.schema";

@Injectable()
export class ConversationAccessService {
	constructor(
		@InjectModel(Conversation.name)
		private readonly conversationModel: Model<Conversation>,
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
	) { }

	async assertCanAccess(conversationId: string, userId: string): Promise<void> {
		if (
			!Types.ObjectId.isValid(conversationId) ||
			!Types.ObjectId.isValid(userId)
		) {
			throw new BadRequestException("Invalid conversation or user ID");
		}

		const conversationObjectId = new Types.ObjectId(conversationId);
		const userObjectId = new Types.ObjectId(userId);
		const [directMembership, applicationParticipation] = await Promise.all([
			this.conversationModel.exists({
				_id: conversationObjectId,
				users: userObjectId,
			}),
			this.applicationModel.exists({
				conversation: conversationObjectId,
				$or: [
					{ applicants: userObjectId },
					{ owner: userObjectId },
					{
						landlord: userObjectId,
						stage: {
							$in: [
								ApplicationStage.SENT,
								ApplicationStage.ACCEPTED,
								ApplicationStage.REJECTED,
							]
						}
					},
				],
			}),
		]);

		if (!directMembership && !applicationParticipation) {
			throw new ForbiddenException(
				"You are not a member of this conversation",
			);
		}
	}
}

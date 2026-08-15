import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Conversation } from "./converstaion.schema";
import { Model, Types } from "mongoose";
import { SendMessageDto } from "./dto/send-message.dto";
import { Message } from "./message.schema";
import { ConversationGateway } from "./conversation.gateway";
import { User } from "../users/users.schema";
import { MessageDto } from "../message/dto/message.dto";
import { plainToInstance } from "class-transformer";
import { ConversationDto } from "./dto/conversation.dto";
import { ConversationAccessService } from "./conversation-access.service";

@Injectable()
export class ConversationService {
	constructor(
		@InjectModel(Conversation.name)
		private readonly conversationModel: Model<Conversation>,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
		private readonly conversationGateway: ConversationGateway,
		private readonly conversationAccessService: ConversationAccessService,
	) { }

	async sendMessage(
		body: SendMessageDto,
		conversationId: string,
		senderId: string
	) {
		await this.conversationAccessService.assertCanAccess(
			conversationId,
			senderId,
		);

		const message = await this.messageModel.create({
			sender: senderId,
			conversation: conversationId,
			data: body.message,
			deliveredTo: [],
			seenUsers: []
		});


		await this.conversationModel.updateOne(
			{ _id: conversationId },
			{ lastMessage: message._id }
		);

		const messageDto = plainToInstance(MessageDto, message.toObject(), {
			excludeExtraneousValues: true,
		})
		await this.conversationGateway.emitNewMessage(conversationId, messageDto);
	}

	async create(
		name: string,
		user: User,
	) {
		return await this.conversationModel.create({
			name: name,
			createdBy: user._id,
			users: [user._id]
		});
	}

	async getAll(id: string): Promise<MessageDto[]> {
		const messages = await this.messageModel.find({
			conversation: id
		}).populate("sender").exec();

		return messages.map(message => plainToInstance(MessageDto, message.toObject(), {
			excludeExtraneousValues: true
		}))
	}

	async getById(id: string, userId: string): Promise<ConversationDto> {
		await this.conversationAccessService.assertCanAccess(id, userId);
		const conv = await this.conversationModel.findById(new Types.ObjectId(id))
			.populate({
				path: "messages",
				populate: { path: "sender" }
			})
			.populate("users")
			.exec();
		if (!conv) {
			throw new NotFoundException("no such conversation exists");
		}
		return plainToInstance(ConversationDto, conv.toObject(), {
			excludeExtraneousValues: true
		});
	}
}

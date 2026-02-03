import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Conversation } from "./converstaion.schema";
import { Model, Types } from "mongoose";
import { SendMessageDto } from "./dto/send-message.dto";
import { Message } from "./message.schema";
import { ConversationGateway } from "./conversation.gateway";
import { User } from "src/users/users.schema";
import { MessageDto } from "src/message/dto/message.dto";
import { plainToInstance } from "class-transformer";
import { ConversationDto } from "./dto/conversation.dto";
import { NotFound } from "@aws-sdk/client-s3";

@Injectable()
export class ConversationService {
	constructor(
		@InjectModel(Conversation.name)
		private readonly conversationModel: Model<Conversation>,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
		private readonly conversationGateway: ConversationGateway,
	) { }

	async sendMessage(
		body: SendMessageDto,
		conversationId: string,
		senderId: string
	) {
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
		this.conversationGateway.emitNewMessage(conversationId, messageDto);
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

	async getById(id: string): Promise<ConversationDto> {
		const conv = await this.conversationModel.findById(new Types.ObjectId(id))
			.populate({
				path: "messages",
				populate: { path: "sender" }
			})
			.exec();
		if (!conv) {
			throw new NotFoundException("no such conversation exists");
		}
		return plainToInstance(ConversationDto, conv.toObject(), {
			excludeExtraneousValues: true
		});
	}
}

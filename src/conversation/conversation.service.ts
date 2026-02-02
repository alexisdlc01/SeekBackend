import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Conversation } from "./converstaion.schema";
import { Model, Types } from "mongoose";
import { ConfigService } from "@nestjs/config";
import { SendMessageDto } from "./dto/send-message.dto";
import { Message } from "./message.schema";
import { ConversationGateway } from "./conversation.gateway";
import { User } from "src/users/users.schema";

@Injectable()
export class ConversationService {
	constructor(
		@InjectModel(Conversation.name)
		private readonly conversationModel: Model<Conversation>,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
		private readonly conversationGateway: ConversationGateway,
		private readonly configService: ConfigService
	) { }

	async sendMessage(
		body: SendMessageDto,
		conversationId: string,
		senderId: string
	) {
		const message = await this.messageModel.create({
			sender: senderId,
			conversation: conversationId,
			data: body.messageData,
			deliveredTo: [],
			seenUsers: []
		});
		await this.conversationModel.updateOne(
			{ _id: conversationId },
			{ lastMessage: message._id }
		);
		this.conversationGateway.emitNewMessage(conversationId, message);
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
}

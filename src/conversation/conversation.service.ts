import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Conversation } from "./converstaion.schema";
import { Model, Types } from "mongoose";
import { SendMessageDto } from "./dto/send-message.dto";
import { Message, MessageType } from "./message.schema";
import { ConversationGateway } from "./conversation.gateway";
import { User } from "../users/users.schema";
import { MessageDto } from "../message/dto/message.dto";
import { plainToInstance } from "class-transformer";
import { ConversationDto } from "./dto/conversation.dto";
import { ConversationAccessService } from "./conversation-access.service";
import { NotificationsService, conversationDedupeKey } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { NotificationTargetKind, notificationTarget } from "../notifications/links";
import { Role } from "../auth/role.enum";

const PREVIEW_LENGTH = 80;

@Injectable()
export class ConversationService {
	private readonly logger = new Logger(ConversationService.name);

	constructor(
		@InjectModel(Conversation.name)
		private readonly conversationModel: Model<Conversation>,
		@InjectModel(Message.name)
		private readonly messageModel: Model<Message>,
		private readonly conversationGateway: ConversationGateway,
		private readonly conversationAccessService: ConversationAccessService,
		private readonly notificationsService: NotificationsService,
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
		if (await this.conversationModel.exists({ _id: conversationId, closedAt: { $ne: null } })) {
			throw new ForbiddenException("This conversation is closed.");
		}

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

		await message.populate("sender");
		const messageDto = plainToInstance(MessageDto, message.toObject(), {
			excludeExtraneousValues: true,
		})
		await this.conversationGateway.emitNewMessage(conversationId, messageDto);
		await this.notifyRecipients(conversationId, senderId, message);
	}

	/**
	 * In-app notification + push for every other member, grouped: one per
	 * conversation until the recipient reads it. Never throws.
	 */
	private async notifyRecipients(
		conversationId: string,
		senderId: string,
		message: Pick<Message, "data" | "messageType"> & { sender: unknown }
	) {
		try {
			const conversation = await this.conversationModel
				.findById(conversationId, { users: 1 })
				.populate<{ users: Pick<User, "_id" | "role">[] }>({ path: "users", select: "role" })
				.lean()
				.exec();
			const senderName = (message.sender as Pick<User, "name"> | null)?.name || "Someone";
			const text = message.messageType === MessageType.Text ? message.data.trim() : "";
			const body = !text
				? "Sent you a message."
				: text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
			await this.notificationsService.notifyMany(
				(conversation?.users ?? [])
					.filter(user => user?._id && user._id.toString() !== senderId)
					.map(user => ({
						user: user._id,
						kind: NotificationKind.NEW_MESSAGE,
						title: `New message from ${senderName}`,
						body,
						...notificationTarget(
							user.role === Role.LANDLORD_AGENCY ? "landlord" : "student",
							NotificationTargetKind.CONVERSATION,
							conversationId
						),
						dedupeKey: conversationDedupeKey(conversationId),
						dedupeUntilRead: true
					}))
			);
		} catch (error) {
			this.logger.warn(`Message notifications not sent: ${(error as Error)?.message}`);
		}
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

	async getAllForUser(userId: string): Promise<ConversationDto[]> {
		const userObjectId = new Types.ObjectId(userId);

		const conversations = await this.conversationModel
			.find({ users: userObjectId })
			.populate("users")
			.populate({ path: "lastMessage", populate: { path: "sender" } })
			.exec();

		// Messages in these conversations sent by someone else that this user
		// hasn't seen yet, counted per conversation in one query.
		const unread = await this.messageModel.aggregate<{
			_id: Types.ObjectId;
			count: number;
		}>([
			{
				$match: {
					conversation: { $in: conversations.map(c => c._id) },
					sender: { $ne: userObjectId },
					seenUsers: { $ne: userObjectId }
				}
			},
			{ $group: { _id: "$conversation", count: { $sum: 1 } } }
		]);
		const unreadByConversation = new Map(
			unread.map(u => [u._id.toString(), u.count])
		);

		const lastActivity = (dto: ConversationDto) =>
			new Date(dto.lastMessage?.createdAt ?? dto.createdAt).getTime();

		return conversations
			.map(conv => {
				const dto = plainToInstance(ConversationDto, conv.toObject(), {
					excludeExtraneousValues: true
				});
				dto.messages = dto.messages ?? [];
				dto.unreadCount =
					unreadByConversation.get(conv._id.toString()) ?? 0;
				return dto;
			})
			.sort((a, b) => lastActivity(b) - lastActivity(a));
	}

	async getById(id: string, userId: string): Promise<ConversationDto> {
		await this.conversationAccessService.assertCanAccess(id, userId);
		const conv = await this.conversationModel.findById(new Types.ObjectId(id))
			.populate({
				path: "messages",
				// Newest first: the mobile chat renders an inverted list; the web re-sorts on its own.
				options: { sort: { createdAt: -1 } },
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

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { SendMessageDto } from "./dto/send-message.dto";
import { ConversationService } from "./conversation.service";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { GetConversationApiDocs } from "./message-swagger.decorator";

@Controller("conversation")
export class ConversationController {
	constructor(private readonly conversationService: ConversationService) { }

	@Post(":id/sendMessage")
	@StudentOrLandlord()
	async sendMessage(
		@Param("id") conversationId: string,
		@Body() body: SendMessageDto,
		@CurrentUser() user: User
	) {
		await this.conversationService.sendMessage(
			body,
			conversationId,
			user._id.toString()
		);
	}

	@GetConversationApiDocs()
	@Get(":id")
	@StudentOrLandlord()
	async getConversation(
		@Param("id") id: string,
	) {
		return await this.conversationService.getById(id);
	}
}

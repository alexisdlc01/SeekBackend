import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import { ConversationDto } from "./dto/conversation.dto";
import { MessageDto } from "src/message/dto/message.dto";

export const GetConversationApiDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: ConversationDto,
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

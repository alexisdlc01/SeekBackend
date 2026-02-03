import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import { ConversationDto } from "./dto/conversation.dto";
import { MessageDto } from "src/message/dto/message.dto";

export const DummyConversationDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: ConversationDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const GetMessagesApiDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: MessageDto,
			isArray: true,
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

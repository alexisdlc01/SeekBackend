import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import { ConversationDto } from "./dto/conversation.dto";

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

import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import { MessageDto } from "./dto/message.dto";

export const DummyMessageDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: MessageDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

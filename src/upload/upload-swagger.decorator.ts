import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import { PresignResDto } from "./dto/presign.dto";

export const ApiPresignDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: PresignResDto
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiAccessDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: String
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

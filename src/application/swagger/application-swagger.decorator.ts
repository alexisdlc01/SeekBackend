import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../../dto/errorDto.dto";
import { ApplicationDto } from "../dto/application.dto";

export const ApiCreateApplicationDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: ApplicationDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		}),
		ApiResponse({
			status: 404,
			type: ErrorDto
		})
	);
import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "src/dto/errorDto.dto";
import { Flag } from "../flags.schema";

export const CreateFlagDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: Flag
		}),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const GetFlagDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: Flag
		}),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ResolveFlagDocs = () =>
	applyDecorators(
		ApiResponse({ status: 204 }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

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

export const ApiGetAllMyApplicationsDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: ApplicationDto,
			isArray: true
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

export const ApiGetApplicationById = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
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

export const ApiJoinApplication = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
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

export const ApiSendApplication = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
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


export const ApiRejectApplication = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
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


export const ApiAcceptApplication = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
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


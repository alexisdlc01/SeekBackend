import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiResponse } from "@nestjs/swagger";
import { UserDto } from "../dto/user.dto";
import { ErrorDto } from "../../dto/errorDto.dto";
import { CreateUserDto } from "../dto/create-user.dto";
import { SetProfilePicDto } from "../dto/set-profile-pic.dto";
import { SetUsernameDto } from "../dto/set-username.dto";
import { DocumentTypesDto } from "../dto/provided-docs.dto";

export const ApiGetUserDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: UserDto
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

export const ApiCreateUserDocs = () =>
	applyDecorators(
		ApiBody({ type: CreateUserDto }),
		ApiResponse({
			status: 204,
			type: UserDto
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		})
	);

export const ApiSetProfilePicDocs = () =>
	applyDecorators(
		ApiBody({ type: SetProfilePicDto }),
		ApiResponse({
			status: 201,
			type: UserDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 404,
			type: ErrorDto
		})
	);

export const ApiSetUsernameDocs = () =>
	applyDecorators(
		ApiBody({ type: SetUsernameDto }),
		ApiResponse({
			status: 201,
			type: UserDto
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
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

export const ApiGetAllUsersDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: UserDto,
			isArray: true
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiAddDocumentDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);


export const ApiGetDocumentTypes = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: DocumentTypesDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);


import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { PassportDto } from "../dto/passport.dto";
import { DocumentShareDto } from "../dto/document-share.dto";
import { UserDto } from "../dto/user.dto";
import { ErrorDto } from "../../dto/errorDto.dto";
import { CreateUserDto } from "../dto/create-user.dto";
import { SetProfilePicDto } from "../dto/set-profile-pic.dto";
import { SetUsernameDto } from "../dto/set-username.dto";
import { DocumentTypesDto } from "../dto/provided-docs.dto";
import { UpdateUserProfileDto } from "../dto/update-user-profile.dto";
import { PendingDocumentDto } from "../dto/pending-document.dto";

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

export const ApiUpdateCurrentUserDocs = () =>
	applyDecorators(
		ApiBody({ type: UpdateUserProfileDto }),
		ApiResponse({ status: 200, type: UserDto }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto }),
		ApiResponse({ status: 409, type: ErrorDto })
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

export const ApiGetPassportDocs = () =>
	applyDecorators(
		ApiOperation({ summary: "The student's Seek Passport: every document, its status and readiness." }),
		ApiResponse({ status: 200, type: PassportDto }),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiListSharesDocs = () =>
	applyDecorators(
		ApiOperation({ summary: "Landlords who can currently (or could previously) open the student's documents." }),
		ApiResponse({ status: 200, type: [DocumentShareDto] }),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiRevokeShareDocs = () =>
	applyDecorators(
		ApiOperation({ summary: "Stop a landlord from opening the student's documents." }),
		ApiResponse({ status: 204 }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiListPendingDocumentsDocs = () =>
	applyDecorators(
		ApiOperation({ summary: "Seek Passport uploads not yet marked as provided, oldest first (Seek staff, monitoring only)." }),
		ApiResponse({ status: 200, type: [PendingDocumentDto] }),
		ApiResponse({ status: 403, type: ErrorDto })
	);

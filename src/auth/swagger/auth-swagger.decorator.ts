import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiResponse } from "@nestjs/swagger";
import LoginDto from "../dto/login.dto";
import { ErrorDto } from "../../dto/errorDto.dto";
import { CreateUserDto } from "../../users/dto/create-user.dto";
import { VerifyEmailDto } from "../dto/verify-email.dto";
import { ForgotPasswordDto } from "../dto/forgot-password.dto";
import { ConfirmPasswordResetDto } from "../dto/confirm-password-reset.dto";
import { UserDto } from "../../users/dto/user.dto";

export const ApiLoginDocs = () =>
	applyDecorators(
		ApiBody({ type: LoginDto }),
		ApiResponse({
			status: 201,
			schema: {
				type: "object",
				properties: {
					access_token: {
						type: "string"
					},
					refresh_token: {
						type: "string"
					}
				}
			}
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiSignupDocs = () =>
	applyDecorators(
		ApiBody({ type: CreateUserDto }),
		ApiResponse({ status: 201 }),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 409,
			type: ErrorDto
		})
	);

export const ApiVerifyEmailDocs = () =>
	applyDecorators(
		ApiBody({ type: VerifyEmailDto }),
		ApiResponse({
			status: 201,
			schema: {
				type: "object",
				properties: {
					access_token: {
						type: "string"
					},
					refresh_token: {
						type: "string"
					}
				}
			}
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

export const ApiForgotPasswordDocs = () =>
	applyDecorators(
		ApiBody({ type: ForgotPasswordDto }),
		ApiResponse({ status: 201 }),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 404,
			type: ErrorDto
		})
	);

export const ApiConfirmPasswordDocs = () =>
	applyDecorators(
		ApiBody({ type: ConfirmPasswordResetDto }),
		ApiResponse({ status: 201 }),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 404,
			type: ErrorDto
		})
	);

export const ApiGoogleDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200 }),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiGoogleCallbackDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200 }),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiCurrentUserDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 200,
			type: UserDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiRefreshDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: UserDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);

export const ApiLogoutDocs = () =>
	applyDecorators(
		ApiResponse({ status: 201 }),
		ApiResponse({
			status: 401,
			type: ErrorDto
		}),
		ApiResponse({
			status: 404,
			type: ErrorDto
		})
	)

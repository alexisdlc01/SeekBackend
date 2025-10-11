import { IsString, MinLength } from "class-validator";

export class ConfirmPasswordResetDto {
	@IsString()
	userId: string;

	@IsString()
	token: string;

	@IsString()
	@MinLength(8)
	newPassword: string;
}

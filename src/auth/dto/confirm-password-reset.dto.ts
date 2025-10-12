import { IsString, IsStrongPassword } from "class-validator";

export class ConfirmPasswordResetDto {
	@IsString()
	userId: string;

	@IsString()
	token: string;

	@IsStrongPassword()
	password: string;
}

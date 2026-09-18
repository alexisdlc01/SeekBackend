import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsStrongPassword } from "class-validator";

export class ChangePasswordDto {
	@ApiProperty()
	@IsString()
	currentPassword: string;

	@ApiProperty()
	@IsStrongPassword()
	newPassword: string;
}

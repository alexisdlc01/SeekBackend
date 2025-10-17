import { IsString, IsStrongPassword } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ConfirmPasswordResetDto {
	@ApiProperty({ example: "687135f38c94f12e3657f3b2" })
	@IsString()
	userId: string;

	@ApiProperty({
		example: "13d383f672a451386c1f9ed..."
	})
	@IsString()
	token: string;

	@ApiProperty({ example: "P@ssword123Test" })
	@IsStrongPassword()
	newPassword: string;
}

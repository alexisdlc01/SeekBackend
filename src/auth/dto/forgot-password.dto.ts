import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ForgotPasswordDto {
	@ApiProperty()
	@IsString()
	email: string;
}

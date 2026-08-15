import { Transform } from "class-transformer";
import { IsEmail } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ForgotPasswordDto {
	@ApiProperty()
	@IsEmail()
	@Transform(({ value }) => value?.trim().toLowerCase())
	email: string;
}

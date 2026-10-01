import { IsEmail, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class ChangeEmailDto {
	@ApiProperty({
		description:
			"The current password, required to confirm the account holder is making this change."
	})
	@IsString()
	currentPassword: string;

	@ApiProperty({ description: "The address to move the account to." })
	@IsEmail()
	@MaxLength(254)
	@Transform(({ value }) => value?.trim().toLowerCase())
	newEmail: string;
}

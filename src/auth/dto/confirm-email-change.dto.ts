import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ConfirmEmailChangeDto {
	@ApiProperty()
	@IsString()
	userId: string;

	@ApiProperty({ description: "Token from the confirmation email." })
	@IsString()
	token: string;
}

import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetUsernameDto {
	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(80)
	@Matches(/\S/, { message: "name must not be empty" })
	name: string;
}

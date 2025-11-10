import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetUsernameDto {
	@ApiProperty()
	@IsString()
	name: string;
}

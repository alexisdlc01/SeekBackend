import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetProfilePicDto {
	@ApiProperty()
	@IsString()
	url: string;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsString } from "class-validator";
import { FlagCategory } from "../enums/category";

export class CreateFlagDto {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	text: string;

	@ApiProperty({ enum: FlagCategory })
	category: FlagCategory;

	@ApiProperty()
	@IsString()
	reportedUser: string;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsString } from "class-validator";
import { FlagCategory } from "../enums/category";
import { FlagStatus } from "../enums/flag-status";

export class FlagDto {
	@ApiProperty()
	@IsString()
	_id: string;

	@ApiProperty({ enum: FlagStatus })
	@IsEnum(FlagStatus)
	status: FlagStatus;

	@ApiProperty({ enum: FlagCategory })
	category: FlagCategory;

	@ApiProperty()
	@IsString()
	reportedUser: string;

	@ApiProperty()
	@IsString()
	createdBy: string;

	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	text: string;
}

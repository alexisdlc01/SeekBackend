import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsMongoId, IsNotEmpty, IsString, MaxLength } from "class-validator";
import { FlagCategory } from "../enums/category";

export class CreateFlagDto {
	@ApiProperty({ maxLength: 5000 })
	@IsString()
	@IsNotEmpty()
	@MaxLength(5000)
	text: string;

	// Without a validation decorator this field is not whitelisted, and the
	// global pipe's forbidNonWhitelisted rejects the whole request.
	@ApiProperty({ enum: FlagCategory })
	@IsEnum(FlagCategory)
	category: FlagCategory;

	@ApiProperty()
	@IsMongoId()
	reportedUser: string;
}

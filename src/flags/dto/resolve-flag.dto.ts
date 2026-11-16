import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { FlagResolution } from "../enums/flag-resolution";

export class ResolveFlagDto {
	@ApiProperty({ enum: Object.values(FlagResolution) })
	@IsIn(Object.values(FlagResolution))
	status: string;

	@ApiPropertyOptional({ description: "Reply shown to the reporter." })
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	supportResponse?: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class ResolveFlagDto {
	@ApiProperty()
	@IsString()
	status: string;

	@ApiPropertyOptional({ description: "Reply shown to the reporter." })
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	supportResponse?: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	ArrayMaxSize,
	IsArray,
	IsDateString,
	IsEnum,
	IsMongoId,
	IsOptional,
	IsString,
	MaxLength,
	MinLength,
	ValidateIf
} from "class-validator";
import { RepairStatus } from "../repair.schema";

export const MAX_REPAIR_PHOTOS = 5;

export class CreateRepairDto {
	@ApiProperty()
	@IsMongoId()
	tenancy: string;

	@ApiProperty({ example: "Boiler not heating water" })
	@IsString()
	@MinLength(3)
	@MaxLength(120)
	title: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	description?: string;

	@ApiPropertyOptional({ type: [String], description: "Private upload keys from /upload/presign (max 5 photos)." })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(MAX_REPAIR_PHOTOS)
	@IsString({ each: true })
	@MaxLength(200, { each: true })
	photoKeys?: string[];
}

export class UpdateRepairDto {
	@ApiProperty({ enum: RepairStatus })
	@IsEnum(RepairStatus)
	status: RepairStatus;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	scheduledFor?: string | null;
}

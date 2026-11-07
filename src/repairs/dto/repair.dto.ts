import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
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

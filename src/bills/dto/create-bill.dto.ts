import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsDateString,
	IsEnum,
	IsInt,
	IsMongoId,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	MinLength
} from "class-validator";
import { BillCategory, BillSource } from "../bill.schema";

export class CreateBillDto {
	@ApiProperty()
	@IsMongoId()
	tenancy: string;

	@ApiProperty({ example: "Octopus Energy" })
	@IsString()
	@MinLength(2)
	@MaxLength(80)
	provider: string;

	@ApiProperty({ enum: BillCategory })
	@IsEnum(BillCategory)
	category: BillCategory;

	@ApiProperty({ description: "Whole bill, in pence.", example: 14820 })
	@IsInt()
	@Min(0)
	amount: number;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	periodStart?: string;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	periodEnd?: string;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	dueDate?: string;

	@ApiPropertyOptional({ default: false })
	@IsOptional()
	@IsBoolean()
	includedInRent?: boolean;

	@ApiPropertyOptional({ type: [String], description: "Tenant ids. Defaults to every tenant." })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(20)
	@IsMongoId({ each: true })
	splitBetween?: string[];

	@ApiPropertyOptional({ enum: BillSource, default: BillSource.MANUAL })
	@IsOptional()
	@IsEnum(BillSource)
	source?: BillSource;
}

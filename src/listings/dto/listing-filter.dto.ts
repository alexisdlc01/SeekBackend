import {
	IsArray,
	IsEnum,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	Min
} from "class-validator";
import { PropertyType } from "../enums/propertyType.enum";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";

export class ListingFilterDto {
	@ApiPropertyOptional({ enum: PropertyType })
	@IsOptional()
	@IsEnum(PropertyType)
	propertyType: PropertyType;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	numOfPeople: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	monthlyRentMin: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	monthlyRentMax: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	sizeSqMeters: number;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@Transform(({ value }) => {
		if (value === undefined || value === null || value === "") {
			return undefined;
		}
		return Array.isArray(value) ? value : [value];
	})
	@IsArray()
	@IsString({ each: true })
	amenities: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	lat?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	lng?: number;

	@ApiPropertyOptional()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	radius?: number;

	@ApiPropertyOptional({ minimum: 1, description: "1-based page; needs limit" })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({ minimum: 1, maximum: 50 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(50)
	limit?: number;
}

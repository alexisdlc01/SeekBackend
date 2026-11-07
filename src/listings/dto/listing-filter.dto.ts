import {
	IsArray,
	IsBoolean,
	MaxLength,
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

	@ApiPropertyOptional({ description: "Bounding box south edge (map viewport)." })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	minLat?: number;

	@ApiPropertyOptional({ description: "Bounding box north edge (map viewport)." })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	maxLat?: number;

	@ApiPropertyOptional({ description: "Bounding box west edge (map viewport)." })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	minLng?: number;

	@ApiPropertyOptional({ description: "Bounding box east edge (map viewport)." })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	maxLng?: number;

	@ApiPropertyOptional({
		description: "Maximum monthly rent per person, in pounds."
	})
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	maxRent?: number;

	@ApiPropertyOptional({ minimum: 0 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	minBedrooms?: number;

	@ApiPropertyOptional({ type: Boolean })
	@IsOptional()
	@Transform(({ value }) => {
		if (value === true || value === "true" || value === "1") return true;
		if (value === false || value === "false" || value === "0") return false;
		return value;
	})
	@IsBoolean()
	billsIncluded?: boolean;

	@ApiPropertyOptional({ description: "City or town, case-insensitive." })
	@IsOptional()
	@IsString()
	@MaxLength(80)
	city?: string;

	@ApiPropertyOptional({
		description: "Free text matched against title, description and address."
	})
	@IsOptional()
	@IsString()
	@MaxLength(120)
	text?: string;
}

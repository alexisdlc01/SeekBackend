import {
	IsArray,
	IsEnum,
	IsNumber,
	IsOptional,
	IsString
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
}

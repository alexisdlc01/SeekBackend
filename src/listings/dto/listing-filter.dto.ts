import {
	IsArray,
	IsEnum,
	IsNumber,
	IsOptional,
	IsString
} from "class-validator";
import { PropertyType } from "../enums/propertyType.enum";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";

export class ListingFilterDto {
	@ApiProperty({ enum: PropertyType })
	@IsOptional()
	@IsEnum(PropertyType)
	propertyType: PropertyType;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	numOfPeople: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	monthlyRentMin: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	monthlyRentMax: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	sizeSqMeters: number;

	@ApiProperty()
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	amenities: string[];

	@ApiProperty()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	lat?: number;

	@ApiProperty()
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	lng?: number;

	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	radius?: number;
}

import {
	IsEnum,
	IsNumber,
	IsOptional,
	IsString,
	IsArray,
	IsDateString
} from "class-validator";
import { PropertyType } from "../enums/propertyType.enum";
import { Amenity } from "../enums/amenity.enum";
import { FurnishingStatus } from "../enums/furnishingStatus.enum";
import { EpcRating } from "../enums/epcRating.enum";
import { ApiProperty } from "@nestjs/swagger";

export class Step4ItemDto {
	@ApiProperty()
	@IsString()
	name: string;

	@ApiProperty()
	@IsString()
	desc: string;

	@ApiProperty()
	@IsOptional()
	required: boolean;
}

export class CreateListingDto {
	@ApiProperty()
	@IsString()
	propertyTitle: string;

	@ApiProperty()
	@IsString()
	numOfPeople: number;

	@ApiProperty()
	@IsNumber()
	sizeSqMeters: number;

	@ApiProperty({ enum: PropertyType })
	@IsEnum(PropertyType)
	propertyType: PropertyType;

	@ApiProperty()
	@IsString()
	streetAddress: string;

	@ApiProperty()
	@IsString()
	cityTown: string;

	@ApiProperty()
	@IsString()
	postcodeZIP: string;

	@ApiProperty()
	@IsString()
	country: string;

	@ApiProperty()
	@IsNumber()
	bedroomsCount: number;

	@ApiProperty()
	@IsNumber()
	enSuiteBedroomCount: number;

	@ApiProperty()
	@IsNumber()
	bathrooms: number;

	@ApiProperty()
	@IsString()
	propertyDesc: string;

	@ApiProperty()
	@IsNumber()
	monthlyRent: number;

	@ApiProperty()
	@IsNumber()
	securityDeposit: number;

	@ApiProperty()
	@IsDateString()
	availableFrom: string;

	@ApiProperty()
	@IsDateString()
	availableUntil: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	registerOfTitleKey: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	registrationNumber: string;

	@ApiProperty({ enum: FurnishingStatus })
	@IsEnum(FurnishingStatus)
	furnishingStatus: FurnishingStatus;

	@ApiProperty({ enum: EpcRating })
	@IsOptional()
	@IsEnum(EpcRating)
	epcRating: EpcRating;

	@ApiProperty()
	@IsArray()
	photos: string[];

	@ApiProperty()
	@IsOptional()
	@IsString()
	videoTourLink?: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	floorPlanImage?: string;

	@ApiProperty()
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	amenities: string[];

	@ApiProperty({ type: [Step4ItemDto] })
	@IsArray()
	@IsOptional()
	requirements: Step4ItemDto[];
}

export class Step1ListingDto {
	@ApiProperty()
	@IsOptional()
	@IsString()
	propertyTitle: string;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	numOfPeople: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	sizeSqMeters: number;

	@ApiProperty()
	@IsOptional()
	@IsEnum(PropertyType)
	propertyType: PropertyType;

	@ApiProperty()
	@IsOptional()
	@IsString()
	streetAddress: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	cityTown: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	postcodeZIP: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	country: string;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	bedroomsCount: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	enSuiteBedroomCount: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	bathrooms: number;

	@ApiProperty()
	@IsOptional()
	@IsString()
	propertyDesc: string;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	monthlyRent: number;

	@ApiProperty()
	@IsOptional()
	@IsNumber()
	securityDeposit: number;

	@ApiProperty()
	@IsOptional()
	@IsDateString()
	availableFrom: string;

	@ApiProperty()
	@IsOptional()
	@IsDateString()
	availableUntil: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	registerOfTitleKey: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	registrationNumber: string;
}

export class Step2ListingDto {
	@ApiProperty()
	@IsOptional()
	@IsEnum(FurnishingStatus)
	furnishingStatus: FurnishingStatus;

	@ApiProperty()
	@IsOptional()
	@IsEnum(EpcRating)
	epcRating: EpcRating;

	@ApiProperty()
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	amenities: string[];
}

export class Step3ListingDto {
	@ApiProperty()
	@IsOptional()
	@IsArray()
	photos: string[];

	@ApiProperty()
	@IsOptional()
	@IsString()
	videoTourLink?: string;

	@ApiProperty()
	@IsOptional()
	@IsString()
	floorPlanImage?: string;
}

export class Step4ListingDto {
	@ApiProperty({ type: [Step4ItemDto] })
	@IsArray()
	@IsOptional()
	requirements: Step4ItemDto[];
}

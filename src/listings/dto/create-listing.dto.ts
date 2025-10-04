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

// TODO: setup AWS images and shit.

export class CreateListingDto {
	@IsString() propertyTitle: string;
	@IsNumber() sizeSqMeters: number;
	@IsEnum(PropertyType) propertyType: PropertyType;
	@IsString() streetAddress: string;
	@IsString() cityTown: string;
	@IsString() postcodeZIP: string;
	@IsString() country: string;
	@IsNumber() bedroomsCount: number;
	@IsNumber() enSuiteBedroomCount: number;
	@IsNumber() bathrooms: number;
	@IsString() propertyDesc: string;
	@IsNumber() monthlyRent: number;
	@IsNumber() securityDeposit: number;
	@IsDateString() availableFrom: string;
	@IsDateString() availableUntil: string;
	@IsString() registerOfTitleUrl: string;
	@IsEnum(FurnishingStatus) furnishingStatus: FurnishingStatus;
	@IsEnum(EpcRating) epcRating: EpcRating;
	@IsOptional()
	@IsArray()
	@IsEnum(Amenity, { each: true })
	amenities: Amenity[];
	@IsArray() photos: string[];
	@IsOptional() @IsString() videoTourLink?: string;
	@IsOptional() @IsString() floorPlanImage?: string;
}

export class Step1ListingDto {
	@IsString() propertyTitle: string;
	@IsNumber() sizeSqMeters: number;
	@IsEnum(PropertyType) propertyType: PropertyType;
	@IsString() streetAddress: string;
	@IsString() cityTown: string;
	@IsString() postcodeZIP: string;
	@IsString() country: string;
	@IsNumber() bedroomsCount: number;
	@IsNumber() enSuiteBedroomCount: number;
	@IsNumber() bathrooms: number;
	@IsString() propertyDesc: string;
	@IsNumber() monthlyRent: number;
	@IsNumber() securityDeposit: number;
	@IsDateString() availableFrom: string;
	@IsDateString() availableUntil: string;
	@IsString() registerOfTitleUrl: string;
}

export class Step2ListingDto {
	@IsEnum(FurnishingStatus) furnishingStatus: FurnishingStatus;
	@IsEnum(EpcRating) epcRating: EpcRating;
	@IsOptional()
	@IsArray()
	@IsEnum(Amenity, { each: true })
	amenities: Amenity[];
}

export class Step3ListingDto {
	@IsArray() photos: string[];
	@IsOptional() @IsString() videoTourLink?: string;
	@IsOptional() @IsString() floorPlanImage?: string;
}

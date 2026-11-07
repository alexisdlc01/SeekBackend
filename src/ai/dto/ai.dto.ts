import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsIn,
	IsMongoId,
	IsNotEmpty,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	ValidateNested
} from "class-validator";

export class ChatMessageDto {
	@ApiProperty({ enum: ["user", "assistant"] })
	@IsIn(["user", "assistant"])
	role: "user" | "assistant";

	@ApiProperty({ maxLength: 2000, example: "3 bed near Bristol uni under £700 each, bills included" })
	@IsString()
	@IsNotEmpty()
	@MaxLength(2000)
	content: string;
}

export class SearchChatDto {
	@ApiProperty({ type: [ChatMessageDto], description: "The conversation so far, oldest first." })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(20)
	@ValidateNested({ each: true })
	@Type(() => ChatMessageDto)
	messages: ChatMessageDto[];
}

export class SearchFiltersDto {
	@ApiPropertyOptional({ example: "Bristol" })
	city?: string;

	@ApiPropertyOptional({ description: "Monthly rent per person, in pounds.", example: 700 })
	maxRent?: number;

	@ApiPropertyOptional({ example: 3 })
	minBedrooms?: number;

	@ApiPropertyOptional()
	billsIncluded?: boolean;

	@ApiPropertyOptional({ example: "University of Bristol" })
	nearUniversity?: string;

	@ApiPropertyOptional({ description: "YYYY-MM-DD", example: "2027-09-01" })
	moveIn?: string;

	@ApiPropertyOptional({ description: "Neighbourhood matched against the listing text.", example: "Cotham" })
	area?: string;
}

export class ListingSummaryDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ example: "4-bed student house, Cotham" })
	title: string;

	@ApiProperty({ type: String, nullable: true })
	address: string | null;

	@ApiProperty({ type: String, nullable: true })
	city: string | null;

	@ApiProperty({ type: String, nullable: true })
	postcode: string | null;

	@ApiProperty({ type: Number, nullable: true, example: 51.4655 })
	lat: number | null;

	@ApiProperty({ type: Number, nullable: true, example: -2.6005 })
	lng: number | null;

	@ApiProperty({ type: Number, nullable: true, description: "Whole-property monthly rent, in pounds." })
	monthlyRent: number | null;

	@ApiProperty({ type: Number, nullable: true, description: "Monthly rent per person, in pounds." })
	rentPerPerson: number | null;

	@ApiProperty({ type: Number, nullable: true })
	bedrooms: number | null;

	@ApiProperty({ type: Number, nullable: true })
	bathrooms: number | null;

	@ApiProperty()
	billsIncluded: boolean;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	availableFrom: Date | null;

	@ApiProperty({ type: String, nullable: true })
	photo: string | null;

	@ApiProperty({ type: Number, nullable: true, description: "Distance to the university asked about, in km." })
	distanceKm: number | null;

	@ApiProperty({ minimum: 40, maximum: 99, description: "How well the home fits the search, in percent." })
	match: number;

	@ApiProperty({ type: [String], example: ["10 min walk to campus", "bills included"], description: "Why it fits, most important first." })
	reasons: string[];
}

export class ListingCheckDto {
	@ApiProperty({ enum: ["pass", "warn"] })
	kind: "pass" | "warn";

	@ApiProperty({ example: "EPC D: heating may cost more in winter" })
	text: string;
}

export class SearchChatListingDto extends ListingSummaryDto {
	@ApiProperty({
		type: [ListingCheckDto],
		description: "Budget, EPC and (for a student) the landlord's criteria against their Seek Passport."
	})
	checks: ListingCheckDto[];
}

export class SearchChatResponseDto {
	@ApiProperty({ example: "Here are 3-bed homes near the University of Bristol under £700 a month each, bills included. I found 4." })
	reply: string;

	@ApiProperty({ type: SearchFiltersDto })
	filters: SearchFiltersDto;

	@ApiProperty({ type: [SearchChatListingDto] })
	listings: SearchChatListingDto[];

	@ApiProperty({ type: [String], description: "Filters dropped because nothing matched them all.", example: ["billsIncluded"] })
	relaxed: string[];

	@ApiProperty({ type: [String], description: "Quick replies for the next message.", example: ["Quiet streets", "Nightlife", "Either"] })
	suggestions: string[];

	@ApiProperty({ enum: ["ai", "rules"], description: "Whether the model or the built-in parser read the request." })
	source: "ai" | "rules";

	@ApiProperty({ enum: ["gemini", "anthropic", "rules"], description: "Which provider answered: Gemini first, then Anthropic, then the built-in parser." })
	provider: "gemini" | "anthropic" | "rules";
}

export const ADVICE_TOPICS = ["deposit", "bills", "contract", "guarantor", "inbox", "rent", "application"] as const;
export type AdviceTopic = (typeof ADVICE_TOPICS)[number];

export class AdviceRequestDto {
	@ApiProperty({ enum: ADVICE_TOPICS })
	@IsIn(ADVICE_TOPICS as unknown as string[])
	topic: AdviceTopic;

	@ApiPropertyOptional({ description: "Defaults to your current tenancy." })
	@IsOptional()
	@IsMongoId()
	tenancyId?: string;

	@ApiPropertyOptional({ description: "With topic application: assess this household (criteria and each member's Seek Passport) instead of the overview. Landlord of the listing or a household member only." })
	@IsOptional()
	@IsMongoId()
	applicationId?: string;

	@ApiPropertyOptional({ maxLength: 500, example: "When will I get my deposit back?", description: "A question in your own words, answered from the same facts as the card." })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	question?: string;

	@ApiPropertyOptional({ example: "email-3f2a9c0d1e4b5a6c7d8e9f01", description: "Inbox thread, for topic inbox." })
	@IsOptional()
	@IsString()
	@Matches(/^(seek|email)-[0-9a-f]{24}$/i)
	threadId?: string;
}

export class AdviceActionDto {
	@ApiProperty({ example: "Check your deposit with DPS" })
	label: string;

	@ApiProperty({ example: "https://www.depositprotection.com" })
	link: string;
}

export class AdviceResponseDto {
	@ApiProperty({ example: "Your deposit is protected" })
	title: string;

	@ApiProperty()
	advice: string;

	@ApiPropertyOptional({ type: [AdviceActionDto] })
	actions?: AdviceActionDto[];

	@ApiProperty({ enum: ["ai", "rules"] })
	source: "ai" | "rules";

	@ApiProperty({ enum: ["gemini", "anthropic", "rules"] })
	provider: "gemini" | "anthropic" | "rules";

	@ApiPropertyOptional({
		type: String,
		nullable: true,
		description: "topic inbox with a threadId: a reply to the last message received, ready to edit. Null when AI replies are off."
	})
	suggestedReply?: string | null;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { EmailCategory } from "../email-category.enum";

export class InboxQueryDto {
	@ApiPropertyOptional({ enum: EmailCategory, description: "Only threads in this category." })
	@IsOptional()
	@Transform(({ value }) => (typeof value === "string" ? value.toUpperCase() : value))
	@IsEnum(EmailCategory)
	category?: EmailCategory;
}

export class InboxThreadDto {
	@ApiProperty({ example: "seek-6650f0c2a1b2c3d4e5f60718", description: "seek-<conversationId> or email-<threadKey>." })
	id: string;

	@ApiProperty({ enum: ["seek", "email"] })
	kind: "seek" | "email";

	@ApiProperty({ example: "James Holloway" })
	name: string;

	@ApiProperty({ example: "12 Cotham Road · your landlord" })
	sub: string;

	@ApiProperty({ example: "Landlord · Seek and email" })
	via: string;

	@ApiProperty()
	preview: string;

	@ApiProperty({ type: String, format: "date-time" })
	time: string;

	@ApiProperty({ example: "14:05", description: "Short UK-time label for lists." })
	timeLabel: string;

	@ApiProperty({ enum: EmailCategory })
	category: EmailCategory;

	@ApiProperty()
	unread: boolean;

	@ApiProperty()
	unreadCount: number;

	@ApiProperty({ example: "JH" })
	initials: string;

	@ApiProperty({ type: [String], enum: ["seek", "email"], isArray: true })
	channels: ("seek" | "email")[];

	@ApiProperty({ type: String, nullable: true })
	tenancyId: string | null;
}

export class InboxAttachmentDto {
	@ApiProperty({ example: "Gas-safety-2026.pdf" })
	name: string;

	@ApiProperty({ description: "Empty when the file could not be stored." })
	url: string;

	@ApiProperty({ type: String, nullable: true, description: "Private storage key, for a signed download." })
	key: string | null;

	@ApiProperty({ type: String, nullable: true, example: "My home › Documents" })
	filedAs: string | null;
}

export class InboxMessageDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ example: "James Holloway" })
	from: string;

	@ApiProperty()
	me: boolean;

	@ApiProperty({ enum: ["Seek", "Email"] })
	via: "Seek" | "Email";

	@ApiProperty({ type: String, format: "date-time" })
	time: string;

	@ApiProperty({ example: "14:05" })
	timeLabel: string;

	@ApiPropertyOptional({ description: "Email subject." })
	subject?: string;

	@ApiProperty()
	text: string;

	@ApiPropertyOptional({ type: InboxAttachmentDto, description: "First attachment." })
	attachment?: InboxAttachmentDto;

	@ApiProperty({ type: [InboxAttachmentDto] })
	attachments: InboxAttachmentDto[];
}

export class InboxRentSummaryDto {
	@ApiProperty({ description: "Tenants who have paid this month's rent." })
	paid: number;

	@ApiProperty({ description: "Tenants on the tenancy." })
	total: number;
}

export class InboxThreadDetailDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ enum: ["seek", "email"] })
	kind: "seek" | "email";

	@ApiProperty()
	name: string;

	@ApiProperty()
	sub: string;

	@ApiProperty({ enum: EmailCategory })
	category: EmailCategory;

	@ApiProperty({ type: String, nullable: true })
	tenancyId: string | null;

	@ApiProperty({ description: "A reply can go through Seek (Seek threads only)." })
	canReplyBySeek: boolean;

	@ApiProperty({ description: "A reply can go out by email from your own address." })
	canReplyByEmail: boolean;

	@ApiProperty({ type: String, nullable: true, example: "maya.rahman@gmail.com", description: "Your address email replies are sent from." })
	replyFrom: string | null;

	@ApiProperty({
		type: String,
		nullable: true,
		description: "A reply to the last message, ready to edit and send. Null when you wrote last or AI replies are off."
	})
	suggestedReply: string | null;

	@ApiProperty({ type: InboxRentSummaryDto, nullable: true, description: "This month's rent for the thread's tenancy." })
	rent: InboxRentSummaryDto | null;

	@ApiProperty({ type: [InboxMessageDto] })
	messages: InboxMessageDto[];
}

export class InboxReplyDto {
	@ApiProperty({ maxLength: 5000 })
	@IsString()
	@IsNotEmpty()
	@MaxLength(5000)
	text: string;

	@ApiPropertyOptional({
		enum: ["seek", "email"],
		description: "Seek threads go through Seek unless this is email. Email threads always reply by email."
	})
	@IsOptional()
	@IsIn(["seek", "email"])
	via?: "seek" | "email";
}

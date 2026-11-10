import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsString, Matches, MaxLength } from "class-validator";
import { DocumentStatus, DocumentType } from "../types/document-type";

const ITEM_STATUSES = [...Object.values(DocumentStatus), "MISSING"];

export class PassportItemDto {
	@ApiProperty({ enum: DocumentType })
	type: DocumentType;

	@ApiProperty()
	label: string;

	@ApiProperty({ enum: ITEM_STATUSES })
	status: DocumentStatus | "MISSING";

	@ApiProperty()
	required: boolean;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	expiresAt: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	uploadedAt: Date | null;

	@ApiPropertyOptional({ nullable: true, description: "Only for the owner or a viewer with an active share." })
	url?: string | null;

	@ApiPropertyOptional({ nullable: true, description: "Only for the owner or a viewer with an active share." })
	key?: string | null;

	@ApiPropertyOptional({ enum: ["document", "university email", "request"], nullable: true, description: "Where the item came from. Student status can come from a confirmed university email; \"request\" means Seek emailed a guarantor or referee and is waiting on their reply (status PENDING)." })
	source?: "document" | "university email" | "request" | null;

	@ApiPropertyOptional({ type: String, nullable: true, description: "E.g. the confirmed university email, or the name of the guarantor or referee asked. Only for the owner or a viewer with an active share." })
	detail?: string | null;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true, description: "When Seek emailed the guarantor or referee (source \"request\" only)." })
	requestedAt?: Date | null;
}

export class PassportSectionDto {
	@ApiProperty({ enum: ["identity", "studies", "money", "references"] })
	key: "identity" | "studies" | "money" | "references";

	@ApiProperty()
	label: string;

	@ApiProperty({ type: [PassportItemDto] })
	items: PassportItemDto[];
}

export class PassportDto {
	@ApiProperty({ description: "Every required item is verified." })
	ready: boolean;

	@ApiProperty({ description: "Number of passport items." })
	total: number;

	@ApiProperty({ description: "Number of verified items." })
	completed: number;

	@ApiProperty({ description: "completed / total, 0-100." })
	percent: number;

	@ApiProperty({ enum: DocumentType, isArray: true })
	missingRequired: DocumentType[];

	@ApiProperty({ type: [PassportSectionDto] })
	sections: PassportSectionDto[];
}

/** Who Seek can email for the student: a UK guarantor or a referee. */
export const REQUESTABLE_DOCUMENTS = [
	DocumentType.GUARANTOR_AGREEMENT,
	DocumentType.LANDLORD_REFERENCE,
	DocumentType.AGENT_REFERENCE,
	DocumentType.RECOMMENDATION
] as const;

export class RequestReferenceDto {
	@ApiProperty({ enum: REQUESTABLE_DOCUMENTS, description: "GUARANTOR_AGREEMENT invites a UK guarantor; the others ask a previous landlord, letting agent or academic for a reference." })
	@IsIn(REQUESTABLE_DOCUMENTS)
	type: (typeof REQUESTABLE_DOCUMENTS)[number];

	@ApiProperty({ example: "Aisha Rahman", description: "Guarantor or referee name." })
	@IsString()
	@Matches(/\S/, { message: "Enter a name." })
	@MaxLength(100)
	name: string;

	@ApiProperty({ example: "aisha@example.com" })
	@IsEmail()
	@MaxLength(254)
	email: string;
}

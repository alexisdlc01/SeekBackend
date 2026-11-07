import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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

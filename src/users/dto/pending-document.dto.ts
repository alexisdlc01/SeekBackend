import { ApiProperty } from "@nestjs/swagger";
import { DocumentType } from "../types/document-type";

/** A Seek Passport upload waiting for staff review. */
export class PendingDocumentDto {
	@ApiProperty()
	userId: string;

	@ApiProperty({ type: String, nullable: true })
	name: string | null;

	@ApiProperty()
	email: string;

	@ApiProperty({ enum: DocumentType })
	type: DocumentType;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	uploadedAt: Date | null;

	@ApiProperty({ type: String, nullable: true, description: "Signed link to open the file, valid 60 seconds. Null if the file has no private key." })
	url: string | null;
}

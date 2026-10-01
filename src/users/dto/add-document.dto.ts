import { IsEnum, IsString, IsUrl } from "class-validator";
import { DocumentType } from "../types/document-type";
import { ApiProperty } from "@nestjs/swagger";

export class AddDocumentDto {
	@ApiProperty({ enum: DocumentType })
	@IsEnum(DocumentType)
	documentType: DocumentType;

	@ApiProperty()
	@IsUrl()
	url: string;

	@ApiProperty({
		description:
			"Object key returned by /upload/presign. Must have been issued to the calling account."
	})
	@IsString()
	key: string;
}

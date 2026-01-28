import { IsEnum, IsString, IsUrl } from "class-validator";
import { DocumentType } from "../types/document-type";
import { ApiProperty } from "@nestjs/swagger";

export class AddDocumentDto {
	@ApiProperty({enum: DocumentType})
	@IsEnum(DocumentType)
	documentType: DocumentType;

	@ApiProperty()
	@IsUrl()
	url: string;
}

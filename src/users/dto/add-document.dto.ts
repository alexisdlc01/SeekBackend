import { IsEnum, IsString, IsUrl } from "class-validator";
import { DocumentType } from "../types/document-type";

export class AddDocumentDto {
	@IsEnum(DocumentType)
	documentType: DocumentType;

	@IsUrl()
	url: string;
}

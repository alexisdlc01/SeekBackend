import { ApiProperty } from "@nestjs/swagger";
import { DocumentType } from "../types/document-type"

export class DocumentTypesDto {
	@ApiProperty({ isArray: true, enum: DocumentType })
	data: DocumentType[];
}




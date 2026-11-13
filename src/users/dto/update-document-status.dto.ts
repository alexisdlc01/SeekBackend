import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";
import { DocumentStatus } from "../types/document-type";

export class UpdateDocumentStatusDto {
	@ApiProperty({ enum: DocumentStatus, description: "Only PENDING is accepted: it runs the automatic check again." })
	@IsEnum(DocumentStatus)
	status: DocumentStatus;
}

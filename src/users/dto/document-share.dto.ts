import { ApiProperty } from "@nestjs/swagger";

class ShareViewerDto {
	@ApiProperty()
	_id: string;

	@ApiProperty({ required: false })
	name?: string;

	@ApiProperty({ required: false })
	companyName?: string;
}

class ShareListingDto {
	@ApiProperty()
	_id: string;

	@ApiProperty({ required: false })
	propertyTitle?: string;

	@ApiProperty({ required: false })
	streetAddress?: string;

	@ApiProperty({ required: false })
	cityTown?: string;
}

export class DocumentShareDto {
	@ApiProperty()
	_id: string;

	@ApiProperty({ type: ShareViewerDto })
	viewer: ShareViewerDto;

	@ApiProperty({ type: ShareListingDto, nullable: true })
	listing: ShareListingDto | null;

	@ApiProperty({ nullable: true, type: String })
	application: string | null;

	@ApiProperty({ type: String, format: "date-time" })
	expiresAt: Date;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	revokedAt: Date | null;

	@ApiProperty({ description: "Not revoked and not yet expired." })
	active: boolean;
}

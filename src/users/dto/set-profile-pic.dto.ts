import { IsUrl, ValidateIf } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetProfilePicDto {
	/**
	 * Rendered by both clients, so it must be a real https URL and never a
	 * scheme like javascript: that could execute if it ever reaches an href.
	 * An empty string clears the picture.
	 */
	@ApiProperty({ description: "Send an empty string to clear it." })
	@ValidateIf((_object, value) => value !== "")
	@IsUrl({ protocols: ["https"], require_protocol: true })
	url: string;
}

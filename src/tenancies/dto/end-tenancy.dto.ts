import { ApiProperty } from "@nestjs/swagger";
import { Matches } from "class-validator";

export class EndTenancyDto {
	@ApiProperty({ type: String, format: "date", description: "The first London calendar day no longer covered by the tenancy." })
	@Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: "endDate must look like YYYY-MM-DD" })
	endDate: string;
}

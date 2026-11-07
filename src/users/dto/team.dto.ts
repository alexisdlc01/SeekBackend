import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsEnum } from "class-validator";
import { TeamScope } from "../types/team-scope";

export class InviteTeamMemberDto {
	@ApiProperty({ example: "sam@holloway-lets.co.uk" })
	@IsEmail()
	email: string;

	@ApiProperty({ enum: TeamScope, isArray: true, example: [TeamScope.VIEWINGS_INBOX], description: "There is no payouts scope." })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(5)
	@IsEnum(TeamScope, { each: true })
	scopes: TeamScope[];
}

export class TeamMemberDto {
	@ApiProperty()
	id: string;

	@ApiProperty()
	email: string;

	@ApiProperty({ type: String, nullable: true, description: "The member's name, once they have a Seek account." })
	name: string | null;

	@ApiProperty({ enum: TeamScope, isArray: true })
	scopes: TeamScope[];

	@ApiProperty({ description: "The invitee accepted the invite with this email. False while the invite is pending." })
	hasAccount: boolean;

	@ApiProperty({ type: String, format: "date-time" })
	invitedAt: Date;

	@ApiProperty({ enum: [false], description: "Team members never see payouts." })
	canSeePayouts: false;
}

/** An invite waiting for the signed-in user to accept. */
export class TeamInviteDto {
	@ApiProperty({ description: "The landlord who invited you; use it to accept." })
	ownerId: string;

	@ApiProperty()
	ownerName: string;

	@ApiProperty({ enum: TeamScope, isArray: true })
	scopes: TeamScope[];

	@ApiProperty({ type: String, format: "date-time" })
	invitedAt: Date;
}

export class DeleteAccountResultDto {
	@ApiProperty({ type: String, format: "date-time" })
	deletedAt: Date;
}

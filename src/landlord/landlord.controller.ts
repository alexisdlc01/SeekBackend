import { TeamAccess, ANY_TEAM_SCOPE } from "../auth/decorators/team-access.decorator";
import { Controller, Get } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { LandlordAgency } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { LandlordOverviewService } from "./landlord-overview.service";

@Controller("landlord")
export class LandlordController {
	constructor(private readonly overviewService: LandlordOverviewService) {}

	@TeamAccess()
	@Get("overview")
	@LandlordAgency()
	@ApiOperation({
		summary: "Dashboard numbers: rent this month (pence), late payments, occupancy, applicants, compliance and recent activity."
	})
	async overview(@CurrentUser() user: User) {
		return this.overviewService.overview(user._id.toString());
	}

	@TeamAccess(...ANY_TEAM_SCOPE)
	@Get("listings")
	@LandlordAgency()
	@ApiOperation({
		summary: "Your listings with views, applications received and how many open households are qualified. Drafts include their draftStep."
	})
	async listings(@CurrentUser() user: User) {
		return this.overviewService.listingsWithStats(user._id.toString());
	}
}

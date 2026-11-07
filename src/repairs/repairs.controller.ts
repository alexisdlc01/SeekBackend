import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
	LandlordAgency,
	StudentOrLandlord,
	StudentOrLandlordOrSuperuser
} from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { RepairsService } from "./repairs.service";
import { Repair } from "./repair.schema";
import { CreateRepairDto, UpdateRepairDto } from "./dto/repair.dto";

@Controller("repairs")
export class RepairsController {
	constructor(private readonly repairsService: RepairsService) {}

	@TeamAccess(TeamScope.REPAIRS)
	@Get("landlord")
	@LandlordAgency()
	@ApiOperation({ summary: "Repairs across the landlord's tenancies, newest first." })
	@ApiResponse({ status: 200, type: [Repair] })
	async landlord(@CurrentUser() user: User) {
		return this.repairsService.listForLandlord(user._id.toString());
	}

	@TeamAccess(TeamScope.REPAIRS, TeamScope.TENANCIES)
	@Get("tenancy/:id")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Repairs for one tenancy." })
	@ApiResponse({ status: 200, type: [Repair] })
	@ApiResponse({ status: 403, type: ErrorDto })
	async forTenancy(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.repairsService.listForTenancy(id, user);
	}

	@TeamAccess(TeamScope.REPAIRS)
	@Post()
	@StudentOrLandlord()
	@ApiOperation({ summary: "Report a repair: a tenant tells the landlord, or a landlord logs one on their own tenancy." })
	@ApiResponse({ status: 201, type: Repair })
	@ApiResponse({ status: 403, type: ErrorDto })
	async create(@Body() body: CreateRepairDto, @CurrentUser() user: User) {
		return this.repairsService.create(body, user);
	}

	@TeamAccess(TeamScope.REPAIRS)
	@Patch(":id")
	@LandlordAgency()
	@ApiOperation({ summary: "Book in or close a repair." })
	@ApiResponse({ status: 200, type: Repair })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async update(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: UpdateRepairDto,
		@CurrentUser() user: User
	) {
		return this.repairsService.update(id, body, user);
	}
}

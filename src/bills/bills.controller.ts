import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { StudentOrLandlordOrSuperuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { BillsService } from "./bills.service";
import { BillViewDto } from "./dto/bill-view.dto";
import { CreateBillDto } from "./dto/create-bill.dto";

@Controller("bills")
export class BillsController {
	constructor(private readonly billsService: BillsService) {}

	@TeamAccess(TeamScope.TENANCIES)
	@Get("tenancy/:id")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Household bills with each tenant's share (shares, myShare in pence)." })
	@ApiResponse({ status: 200, type: [BillViewDto] })
	@ApiResponse({ status: 403, type: ErrorDto })
	async forTenancy(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.billsService.listForTenancy(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post()
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Add a household bill." })
	@ApiResponse({ status: 201, type: BillViewDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	async create(@Body() body: CreateBillDto, @CurrentUser() user: User) {
		return this.billsService.create(body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/paid")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({
		summary: "Mark your share of a bill as paid. The bill turns PAID once every share is; a landlord settles the whole bill."
	})
	@ApiResponse({ status: 200, type: BillViewDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async markPaid(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.billsService.markPaid(id, user);
	}
}

import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
	LandlordAgency,
	Student,
	StudentOrLandlordOrSuperuser
} from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { TenanciesService } from "./tenancies.service";
import { Tenancy } from "./tenancy.schema";
import { CreateTenancyDto } from "./dto/create-tenancy.dto";
import { DepositReceivedDto, PrescribedInfoDto, UpdateDepositDto, UpdateEnergyAllowanceDto } from "./dto/update-deposit.dto";
import { AddTenancyDocumentDto } from "./dto/add-tenancy-document.dto";
import { UpdateBankTransferInstructionsDto } from "./dto/update-bank-transfer-instructions.dto";
import { EndTenancyDto } from "./dto/end-tenancy.dto";

@Controller("tenancies")
export class TenanciesController {
	constructor(private readonly tenanciesService: TenanciesService) {}

	@Get("mine")
	@Student()
	@ApiOperation({ summary: "Tenancies the student lives in, with compliance status." })
	@ApiResponse({ status: 200, type: [Tenancy] })
	async mine(@CurrentUser() user: User) {
		return this.tenanciesService.listMine(user._id.toString());
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Get("landlord")
	@LandlordAgency()
	@ApiOperation({ summary: "The landlord's tenancies, with compliance status." })
	@ApiResponse({ status: 200, type: [Tenancy] })
	async landlord(@CurrentUser() user: User) {
		return this.tenanciesService.listForLandlord(user._id.toString());
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Get(":id")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "One tenancy: listing, people, deposit, documents, compliance." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async get(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.tenanciesService.getDetail(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post()
	@LandlordAgency()
	@ApiOperation({
		summary:
			"Create a tenancy for one of your listings. From an ACCEPTED application its applicants become the tenants and rent is scheduled. By hand, the students are invited (PENDING_ACCEPTANCE) and rent starts once all have accepted."
	})
	@ApiResponse({ status: 201, type: Tenancy })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Application not ACCEPTED, or no student invited." })
	@ApiResponse({ status: 403, type: ErrorDto, description: "Listing or application is not yours." })
	@ApiResponse({ status: 409, type: ErrorDto, description: "The application already has a tenancy." })
	async create(@Body() body: CreateTenancyDto, @CurrentUser() user: User) {
		return this.tenanciesService.create(body, user);
	}

	@Post(":id/accept")
	@Student()
	@HttpCode(200)
	@ApiOperation({ summary: "Accept a tenancy you were invited to. Rent is scheduled when every invited student has accepted." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	async accept(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.tenanciesService.accept(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/deposit")
	@LandlordAgency()
	@ApiOperation({ summary: "Record where the deposit is protected." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async deposit(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: UpdateDepositDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.updateDeposit(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/energy-allowance")
	@LandlordAgency()
	@ApiOperation({ summary: "Set or remove the household's monthly energy fair-use allowance." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async energyAllowance(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: UpdateEnergyAllowanceDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.updateEnergyAllowance(id, body.energyAllowance, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/bank-transfer-instructions")
	@LandlordAgency()
	@ApiOperation({ summary: "Set the bank-transfer payment instructions without changing deposit protection." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	async bankTransferInstructions(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: UpdateBankTransferInstructionsDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.updateBankTransferInstructions(id, body.bankTransferInstructions, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/deposit-received")
	@LandlordAgency()
	@ApiOperation({ summary: "Record the day the deposit was received. The 30-day protection deadline runs from it." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	async depositReceived(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: DepositReceivedDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.markDepositReceived(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post(":id/prescribed-info")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Record that the tenants were sent the deposit scheme's prescribed information." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	async prescribedInfo(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: PrescribedInfoDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.markPrescribedInfoSent(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post(":id/documents")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Add a document (agreement, certificate, inventory...) to the tenancy." })
	@ApiResponse({ status: 201, type: Tenancy })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async addDocument(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: AddTenancyDocumentDto,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.addDocument(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/documents/:docId/confirm")
	@LandlordAgency()
	@ApiOperation({ summary: "Confirm that a tenancy agreement imported from a tenant's mailbox is genuine." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async confirmDocument(
		@Param("id", ParseObjectIdPipe) id: string,
		@Param("docId", ParseObjectIdPipe) docId: string,
		@CurrentUser() user: User
	) {
		return this.tenanciesService.confirmDocument(id, docId, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Patch(":id/end")
	@LandlordAgency()
	@ApiOperation({ summary: "End a tenancy early, remove future unpaid rent and refund unused paid rent." })
	@ApiResponse({ status: 200, type: Tenancy })
	@ApiResponse({ status: 403, type: ErrorDto })
	async end(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: EndTenancyDto,
		@CurrentUser() user: User
	) {
		const [year, month, day] = body.endDate.split("-").map(Number);
		return this.tenanciesService.endTenancy(id, new Date(Date.UTC(year, month - 1, day)), user);
	}
}

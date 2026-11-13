import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiResponse } from "@nestjs/swagger";
import {
	LandlordAgency,
	Student,
	StudentOrLandlordOrSuperuser
} from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { ContractsService } from "./contracts.service";
import { Contract } from "./contract.schema";
import { CreateContractDto } from "./dto/create-contract.dto";
import { CreateContractTemplateDto } from "./dto/create-contract-template.dto";
import { ContractTemplate } from "./contract-template.schema";
import {
	DefaultContractDto,
	DeductionsDto,
	DocumentQueryDto,
	InventoryDto,
	RespondDeductionsDto
} from "./dto/contract-extras.dto";

@Controller("contracts")
export class ContractsController {
	constructor(private readonly contractsService: ContractsService) {}

	@TeamAccess(TeamScope.TENANCIES)
	@Post()
	@LandlordAgency()
	@ApiOperation({ summary: "Add a draft tenancy agreement to one of your tenancies." })
	@ApiResponse({ status: 201, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async create(@Body() body: CreateContractDto, @CurrentUser() user: User) {
		return this.contractsService.create(body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post("default")
	@LandlordAgency()
	@ApiOperation({
		summary:
			"Draft Seek's own agreement for a tenancy: an assured periodic tenancy in England or a standard occupation contract in Wales. Its url and prescribedInformationUrl open as HTML."
	})
	@ApiResponse({ status: 201, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async createDefault(@Body() body: DefaultContractDto, @CurrentUser() user: User) {
		return this.contractsService.createDefault(body.tenancy, user);
	}

	// Opened straight in a browser from the contract's signed url, so no bearer token.
	@Get(":id/document")
	@Header("Content-Type", "text/html; charset=utf-8")
	@Header("Cache-Control", "private, no-store")
	@ApiProduces("text/html")
	@ApiOperation({ summary: "The Seek agreement as HTML. Use the contract's url, which carries its signature." })
	@ApiResponse({ status: 200, description: "HTML document." })
	@ApiResponse({ status: 403, type: ErrorDto })
	async document(@Param("id", ParseObjectIdPipe) id: string, @Query() query: DocumentQueryDto) {
		return this.contractsService.renderDocument(id, "agreement", query.sig);
	}

	@Get(":id/prescribed-information")
	@Header("Content-Type", "text/html; charset=utf-8")
	@Header("Cache-Control", "private, no-store")
	@ApiProduces("text/html")
	@ApiOperation({ summary: "The deposit's prescribed information as HTML. Use the contract's prescribedInformationUrl." })
	@ApiResponse({ status: 200, description: "HTML document." })
	@ApiResponse({ status: 403, type: ErrorDto })
	async prescribedInformation(@Param("id", ParseObjectIdPipe) id: string, @Query() query: DocumentQueryDto) {
		return this.contractsService.renderDocument(id, "prescribed-information", query.sig);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Put(":id/inventory")
	@LandlordAgency()
	@ApiOperation({ summary: "Record the check-in inventory. The tenants are told to check it." })
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 403, type: ErrorDto })
	async inventory(@Param("id", ParseObjectIdPipe) id: string, @Body() body: InventoryDto, @CurrentUser() user: User) {
		return this.contractsService.setInventory(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post(":id/deductions")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({
		summary: "Propose end-of-tenancy deductions from the deposit (never more than the deposit). The tenants accept or dispute."
	})
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	async deductions(@Param("id", ParseObjectIdPipe) id: string, @Body() body: DeductionsDto, @CurrentUser() user: User) {
		return this.contractsService.proposeDeductions(id, body, user);
	}

	@Post(":id/deductions/respond")
	@Student()
	@HttpCode(200)
	@ApiOperation({
		summary: "Accept or dispute the proposed deductions. ACCEPTED once every tenant agrees; DISPUTED as soon as one disagrees."
	})
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	async respondToDeductions(
		@Param("id", ParseObjectIdPipe) id: string,
		@Body() body: RespondDeductionsDto,
		@CurrentUser() user: User
	) {
		return this.contractsService.respondToDeductions(id, body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post("templates")
	@LandlordAgency()
	@ApiOperation({ summary: "Save an uploaded agreement as a reusable template." })
	@ApiResponse({ status: 201, type: ContractTemplate })
	@ApiResponse({ status: 400, type: ErrorDto })
	async createTemplate(@Body() body: CreateContractTemplateDto, @CurrentUser() user: User) {
		return this.contractsService.createTemplate(body, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Get("templates")
	@LandlordAgency()
	@ApiOperation({ summary: "The landlord's saved agreement templates." })
	@ApiResponse({ status: 200, type: [ContractTemplate] })
	async templates(@CurrentUser() user: User) {
		return this.contractsService.listTemplates(user._id.toString());
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Delete("templates/:id")
	@LandlordAgency()
	@HttpCode(204)
	@ApiOperation({ summary: "Delete one of your templates. Contracts already created from it are unaffected." })
	@ApiResponse({ status: 404, type: ErrorDto })
	async deleteTemplate(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.contractsService.deleteTemplate(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Get("landlord")
	@LandlordAgency()
	@ApiOperation({ summary: "Every contract across the landlord's tenancies." })
	@ApiResponse({ status: 200, type: [Contract] })
	async landlord(@CurrentUser() user: User) {
		return this.contractsService.listForLandlord(user._id.toString());
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Get("tenancy/:id")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Contracts for one tenancy." })
	@ApiResponse({ status: 200, type: [Contract] })
	@ApiResponse({ status: 403, type: ErrorDto })
	async forTenancy(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.contractsService.listForTenancy(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post(":id/send")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Send a draft contract to the tenants for signature." })
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	async send(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.contractsService.send(id, user);
	}

	@TeamAccess(TeamScope.TENANCIES)
	@Post(":id/remind")
	@LandlordAgency()
	@HttpCode(200)
	@ApiOperation({ summary: "Email the signing link again to tenants who have not signed a sent contract (once per 24 hours)." })
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 429, type: ErrorDto })
	async remind(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.contractsService.remind(id, user);
	}

	@Post(":id/sign")
	@Student()
	@HttpCode(200)
	@ApiOperation({ summary: "Sign a sent contract. It becomes SIGNED when every tenant has signed." })
	@ApiResponse({ status: 200, type: Contract })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	async sign(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.contractsService.sign(id, user);
	}
}

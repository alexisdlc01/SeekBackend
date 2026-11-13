import {
	Controller,
	Get,
	Post,
	Body,
	Patch,
	Param,
	Delete
} from "@nestjs/common";
import { FlagsService } from "./flags.service";
import { CreateFlagDto } from "./dto/create-flag.dto";
import { ResolveFlagDto } from "./dto/resolve-flag.dto";
import {
	StudentOrLandlordOrSuperuser,
	Superuser
} from "../auth/decorators/role-auth.decorator";
import { CreatedFlagOrSuperuser } from "./decorators/created-flag.decorator";
import {
	CreateFlagDocs,
	GetFlagDocs,
	ResolveFlagDocs
} from "./decorators/flags-swagger.decorator";
import { User } from "../users/users.schema";
import { Flag } from "./flags.schema";
import { ApiResponse } from "@nestjs/swagger";
import { CurrentUser } from "../auth/decorators/current-user.decorator";

@Controller("flags")
export class FlagsController {
	constructor(private readonly flagsService: FlagsService) {}

	@CreateFlagDocs()
	@Post()
	@StudentOrLandlordOrSuperuser()
	create(@Body() createFlagDto: CreateFlagDto, @CurrentUser() user: User) {
		return this.flagsService.create(createFlagDto, user);
	}

	@GetFlagDocs()
	@Get("all")
	@Superuser()
	getAll() {
		return this.flagsService.getAll();
	}

	@ResolveFlagDocs()
	@Patch("/resolve/:id")
	@Superuser()
	resolve(@Param("id") id: string, @Body() resolveFlagDto: ResolveFlagDto) {
		return this.flagsService.resolve(id, resolveFlagDto);
	}

	@ApiResponse({ status: 200, description: "Suspension lifted. The account's listings stay offline until resubmitted." })
	@Patch("/lift-suspension/:userId")
	@Superuser()
	liftSuspension(@Param("userId") userId: string) {
		return this.flagsService.liftSuspension(userId);
	}

	@ApiResponse({ status: 200, type: [Flag], description: "The caller's own reports, newest first." })
	@Get("mine")
	@StudentOrLandlordOrSuperuser()
	mine(@CurrentUser() user: User) {
		return this.flagsService.findMine(user._id);
	}

	@GetFlagDocs()
	@Get(":id")
	@CreatedFlagOrSuperuser()
	findOne(@Param("id") id: string) {
		return this.flagsService.findOne(id);
	}
}

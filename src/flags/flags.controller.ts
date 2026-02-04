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
	Student,
	StudentOrLandlordOrSuperuser,
	Superuser
} from "src/auth/decorators/role-auth.decorator";
import { CreatedFlagOrSuperuser } from "./decorators/created-flag.decorator";
import {
	CreateFlagDocs,
	GetFlagDocs,
	ResolveFlagDocs
} from "./decorators/flags-swagger.decorator";
import { User } from "src/users/users.schema";
import { CurrentUser } from "src/auth/decorators/current-user.decorator";

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
	getAll() {
		return this.flagsService.getAll();
	}

	@ResolveFlagDocs()
	@Patch("/resolve/:id")
	@Superuser()
	resolve(@Param("id") id: string, @Body() resolveFlagDto: ResolveFlagDto) {
		return this.flagsService.resolve(id, resolveFlagDto);
	}

	@GetFlagDocs()
	@Get(":id")
	@CreatedFlagOrSuperuser()
	findOne(@Param("id") id: string) {
		return this.flagsService.findOne(id);
	}
}

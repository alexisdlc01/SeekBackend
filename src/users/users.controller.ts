import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { CreateUserDto } from "./dtos/create-user.dto";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "./users.schema";

@Controller("users")
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Post()
	async createUser(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Get()
	@UseGuards(JwtAuthGuard)
	async getUsers(@CurrentUser() user: User) {
		console.log(user);
		return this.usersService.getAllUsers();
	}
}

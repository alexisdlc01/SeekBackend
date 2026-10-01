import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ContactDto } from "./dto/contact.dto";
import { ReportDto } from "./dto/report.dto";
import { ContactService } from "./contact.service";
import { ApiTags } from "@nestjs/swagger";
import { ApiContactDocs } from "./contact-swagger.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";

@ApiTags("Contact")
@Controller("contact")
export class ContactController {
	constructor(private readonly contactService: ContactService) {}

	@ApiContactDocs()
	@Post()
	// Unauthenticated and sends mail, so it needs a tighter bucket than the
	// global default to stay off the abuse path.
	@Throttle({ default: { limit: 3, ttl: 60 * 60_000, blockDuration: 60_000 } })
	async contact(@Body() body: ContactDto) {
		await this.contactService.contact(body);
	}

	/**
	 * Reporting abuse is a safety control, so it gets its own route rather than
	 * sharing the contact form's quota. Throttler keys are per-handler, so a
	 * burst of general enquiries can no longer exhaust a user's ability to
	 * report someone. Authenticated, which is why it can afford a wider limit.
	 */
	@Post("report")
	@Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
	@UseGuards(JwtAuthGuard)
	async report(@Body() body: ReportDto, @CurrentUser() user: User) {
		return this.contactService.report(body, {
			name: user.name,
			email: user.email
		});
	}
}

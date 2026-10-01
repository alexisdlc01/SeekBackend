import { Injectable } from "@nestjs/common";
import { MailService } from "../auth/mail.service";
import { ContactDto } from "./dto/contact.dto";
import { ReportDto } from "./dto/report.dto";

@Injectable()
export class ContactService {
	constructor(private readonly mailService: MailService) {}

	async contact({ email, message, name }: ContactDto) {
		await this.mailService.sendContactEmail(name, email, message);
	}

	async report(
		{ message, reportedAccount }: ReportDto,
		reporter: { name: string; email: string }
	) {
		await this.mailService.sendReportEmail(
			reporter.name,
			reporter.email,
			message,
			reportedAccount
		);
		return { message: "Report received." };
	}
}

import {
	Controller,
	FileTypeValidator,
	MaxFileSizeValidator,
	ParseFilePipe,
	Post,
	UploadedFile,
	UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { UploadService } from "./upload.service";

@Controller("upload")
export class UploadController {
	constructor(private readonly uploadService: UploadService) {}

	@Post("")
	@UseInterceptors(FileInterceptor("file"))
	async uploadFile(
		@UploadedFile(
			new ParseFilePipe({
				validators: [
					new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }) // 5MB
					// new FileTypeValidator({ fileType: "application/pdf" })
				]
			})
		)
		file: Express.Multer.File
	) {
		await this.uploadService.upload(file.originalname, file.buffer);
	}
}

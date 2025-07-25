import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import * as cookieParser from "cookie-parser";

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	app.enableCors({
		origin: process.env.FRONTEND_URL,
		credentials: true,
	});
	app.useGlobalPipes(new ValidationPipe());
	app.use(cookieParser());
	await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import * as cookieParser from "cookie-parser";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	app.enableCors({
		origin: process.env.FRONTEND_URL,
		credentials: true
	});
	app.useGlobalPipes(new ValidationPipe());
	app.use(cookieParser());

	const config = new DocumentBuilder()
		.setTitle("My API")
		.setDescription("API documentation for my NestJS app")
		.setVersion("1.0")
		.addBearerAuth()
		.build();

	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup("/docs", app, document);

	await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

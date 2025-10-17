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
		.addCookieAuth("access_token", {
			type: "apiKey",
			in: "cookie",
			description: "Access token for web clients"
		})
		.addBearerAuth(
			{
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description: "Access token for mobile clients."
			},
			"mobile-token"
		)
		.build();

	const document = SwaggerModule.createDocument(app, config);
	document.paths = Object.entries(document.paths).reduce(
		(acc, [path, methods]) => {
			acc[path] = Object.entries(methods).reduce(
				(methodAcc, [method, details]) => {
					methodAcc[method] = {
						...details,
						security: [
							{ access_token: [] }, // Cookie auth
							{ "mobile-token": [] } // Bearer auth
						]
					};
					return methodAcc;
				},
				{}
			);
			return acc;
		},
		{}
	);
	SwaggerModule.setup("/docs", app, document);

	await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

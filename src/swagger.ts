import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";

/** The OpenAPI document served at /docs and exported by `npm run openapi:export`. */
export function buildSwaggerDocument(app: INestApplication): OpenAPIObject {
	const config = new DocumentBuilder()
		.setTitle("Seek API")
		.setDescription("Seek: student homes, tenancies, rent, bills, inbox and AI search.")
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
						security: details.security ?? [
							{ access_token: [] },
							{ "mobile-token": [] }
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
	return document;
}

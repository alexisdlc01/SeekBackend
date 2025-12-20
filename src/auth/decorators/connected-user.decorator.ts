import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const ConnectedUser = createParamDecorator(
	(data: unknown, context: ExecutionContext) => {
		console.log("HEREHRE");
		const client = context.switchToWs().getClient();
		return client.data.user;
	}
);

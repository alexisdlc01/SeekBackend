import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

export function PublicEndpoint(summary?: string) {
	return applyDecorators(ApiOperation({ summary, security: [] }));
}

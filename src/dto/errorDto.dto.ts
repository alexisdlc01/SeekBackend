import { ApiProperty } from "@nestjs/swagger";

export class ErrorDto {
  @ApiProperty({ 
    example: 400,
    description: 'HTTP status code'
  })
  statusCode: number;

  @ApiProperty({
    example: 'Bad Request',
    description: 'HTTP error message'
  })
  message: string;

  @ApiProperty({
    example: 'Bad Request',
    description: 'Error type',
    required: false
  })
  error?: string;
}


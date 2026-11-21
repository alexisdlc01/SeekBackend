import { Types } from 'mongoose';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConversationController } from './conversation.controller';
import { SendMessageDto } from './dto/send-message.dto';

describe('ConversationController', () => {
  let controller: ConversationController;
  let conversationService: {
    getById: jest.Mock;
    sendMessage: jest.Mock;
  };

  beforeEach(() => {
    conversationService = {
      getById: jest.fn(),
      sendMessage: jest.fn(),
    };
    controller = new ConversationController(conversationService as never);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('passes the authenticated user to the conversation read check', async () => {
    const conversationId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();

    await controller.getConversation(conversationId, { _id: userId } as never);

    expect(conversationService.getById).toHaveBeenCalledWith(
      conversationId,
      userId.toString(),
    );
  });

  it('passes the authenticated user to the message authorization check', async () => {
    const conversationId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const body = { message: 'Hello' };

    await controller.sendMessage(
      conversationId,
      body,
      { _id: userId } as never,
    );

    expect(conversationService.sendMessage).toHaveBeenCalledWith(
      body,
      conversationId,
      userId.toString(),
    );
  });

  it('rejects a whitespace-only message with a 400', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ message: '   ' }, { type: 'body', metatype: SendMessageDto }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

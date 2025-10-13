import { Test, TestingModule } from '@nestjs/testing';
import { ListingsGateway } from './listings.gateway';

describe('ListingsGateway', () => {
  let gateway: ListingsGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ListingsGateway],
    }).compile();

    gateway = module.get<ListingsGateway>(ListingsGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ReputationService } from "../reputation.service";
import { ContractService } from "../contract.service";

jest.mock("../../config", () => ({
  config: {
    stellar: {
      reputationContractId: "CREPUTATION1234567890",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
  },
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue("mockOp"),
  })),
  Address: jest.fn().mockImplementation(() => ({
    toScVal: jest.fn().mockReturnValue("mockScVal"),
  })),
}));

jest.mock("../contract.service", () => ({
  ContractService: {
    simulateContractRead: jest.fn(),
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe("ReputationService — zero total_weight guard (#778)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null when contract returns None (null)", async () => {
    (ContractService.simulateContractRead as jest.Mock<any>).mockResolvedValue(null);

    const res = await ReputationService.getReputation("GNEWUSER123");
    expect(res).toBeNull();
  });

  it("returns null when total_weight is 0 (unreviewed user)", async () => {
    (ContractService.simulateContractRead as jest.Mock<any>).mockResolvedValue({
      total_score: 0n,
      total_weight: 0n,
      review_count: 0,
    });

    const res = await ReputationService.getReputation("GZEROUSER123");
    expect(res).toBeNull();
  });

  it("returns reputation object when user has non-zero total_weight", async () => {
    (ContractService.simulateContractRead as jest.Mock<any>).mockResolvedValue({
      total_score: 4500n,
      total_weight: 1000n,
      review_count: 2,
    });

    const res = await ReputationService.getReputation("GREVIEWEDUSER123");
    expect(res).toEqual({
      total_score: 4500n,
      total_weight: 1000n,
      review_count: 2,
    });
  });
});

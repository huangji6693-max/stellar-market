import { nativeToScVal } from "@stellar/stellar-sdk";
import type { PrismaClient } from "@prisma/client";
import {
  STROOPS_PER_XLM,
  parseStroops,
  resolveStroops,
  stroopsToXlmNumber,
  stroopsToXlmString,
  xlmToStroops,
} from "../lib/stroops";

jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../config", () => ({
  config: {
    stellar: {
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      secondaryRpcUrl: "https://soroban-testnet.stellar.org/secondary",
      escrowContractId: "CDLZFC3SYJYDZT7K67VZ75YJBMKBAV27Z6Y6Z6Z6Z6Z6Z6Z6Z6Z6Z6Z6Z",
    },
  },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const mockTxBuilder = {
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnThis(),
    toXDR: jest.fn().mockReturnValue("mock-xdr"),
  };

  return {
    Account: jest.fn(),
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({}),
    })),
    Address: jest.fn().mockImplementation(() => ({
      toScVal: jest.fn().mockReturnValue({}),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => mockTxBuilder),
    BASE_FEE: "100",
    nativeToScVal: jest.fn((val: unknown) => val),
    scValToNative: jest.fn(),
    xdr: {
      ScVal: { scvU64: jest.fn() },
      Uint64: jest.fn(),
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn().mockResolvedValue({
          accountId: () => "GCLIENT",
          sequenceNumber: () => "1",
          incrementSequenceNumber: () => {},
        }),
      })),
      Api: {
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
        },
      },
    },
  };
});

import { ContractService } from "../services/contract.service";

describe("Fixed-point stroops <-> XLM conversion and on-chain sync (#942)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("stroops fixed-point conversion helpers", () => {
    it("round-trips stroop amounts that lose precision under the old float path (e.g. 0.29 XLM = 2,900,000 stroops)", () => {
      // Under the legacy implementation:
      //   const xlm = Number(2_900_000n) / 10_000_000; // 0.29
      //   BigInt(Math.floor(xlm * 10_000_000)) === 2_899_999n (lost 1 stroop!)
      const legacyRoundTrip = (stroops: bigint): bigint => {
        const xlm = Number(stroops) / Number(STROOPS_PER_XLM);
        return BigInt(Math.floor(xlm * Number(STROOPS_PER_XLM)));
      };

      const driftProneStroops = [
        10_000_002n, // 1.0000002 XLM -> (Number(s) / 1e7) * 1e7 = 10000001.999999998
        10_000_006n, // 1.0000006 XLM -> (Number(s) / 1e7) * 1e7 = 10000005.999999998
        10_000_021n, // 1.0000021 XLM -> (Number(s) / 1e7) * 1e7 = 10000020.999999998
        10_000_025n, // 1.0000025 XLM -> (Number(s) / 1e7) * 1e7 = 10000024.999999998
        10_000_040n, // 1.000004 XLM  -> (Number(s) / 1e7) * 1e7 = 10000039.999999998
      ];

      for (const original of driftProneStroops) {
        // Confirm the old float path genuinely drifted by -1 stroop:
        expect(legacyRoundTrip(original)).toBe(original - 1n);

        // Confirm the new fixed-point path preserves exact stroops across both
        // string and number XLM representations:
        const xlmStr = stroopsToXlmString(original);
        const xlmNum = stroopsToXlmNumber(original);
        expect(xlmToStroops(xlmStr)).toBe(original);
        expect(xlmToStroops(xlmNum)).toBe(original);
      }
    });

    it("does not drift across 50 repeated sync/serialize round-trips", () => {
      let currentStroops = 10_000_002n;
      for (let i = 0; i < 50; i++) {
        const xlm = stroopsToXlmNumber(currentStroops);
        currentStroops = xlmToStroops(xlm);
      }
      expect(currentStroops).toBe(10_000_002n);
    });

    it("preserves exact precision for i128 stroop amounts exceeding Number.MAX_SAFE_INTEGER", () => {
      const highPrecisionStroops = 9_007_199_254_740_993n; // 2^53 + 1 (> MAX_SAFE_INTEGER)
      const xlmStr = stroopsToXlmString(highPrecisionStroops);
      expect(xlmStr).toBe("900719925.4740993");
      expect(xlmToStroops(xlmStr)).toBe(highPrecisionStroops);
      expect(resolveStroops(stroopsToXlmNumber(highPrecisionStroops), highPrecisionStroops.toString())).toBe(
        highPrecisionStroops,
      );
      expect(parseStroops(highPrecisionStroops.toString())).toBe(highPrecisionStroops);
    });
  });

  describe("ContractService.syncJobFromChain & reverse tx builders", () => {
    it("syncs on-chain stroop amounts without float division drift and round-trips exact stroops into tx builders", async () => {
      const m1Stroops = 2_900_000n; // 0.29 XLM
      const m2Stroops = 199_900_000n; // 19.99 XLM
      const m3Stroops = 10_000_003n; // 1.0000003 XLM
      const totalStroops = m1Stroops + m2Stroops + m3Stroops; // 212_800_003n (21.2800003 XLM)

      jest.spyOn(ContractService as unknown as { simulateContractRead: () => Promise<unknown> }, "simulateContractRead")
        .mockResolvedValueOnce({
          total_amount: totalStroops,
          milestones: [
            {
              id: 0,
              description: "Phase 1",
              amount: m1Stroops,
              status: ["Pending"],
              deadline: 1_800_000_000n,
            },
            {
              id: 1,
              description: "Phase 2",
              amount: m2Stroops,
              status: ["InProgress"],
              deadline: 1_800_086_400n,
            },
            {
              id: 2,
              description: "Phase 3",
              amount: m3Stroops,
              status: ["Approved"],
              deadline: 1_800_172_800n,
            },
          ],
        });

      const createdMilestones: Array<{
        description: string;
        amount: number;
        amountStroops: string;
        contractDeadline: Date;
      }> = [];
      let updatedJobData: { budget?: number; budgetStroops?: string } | undefined;

      const mockTx = {
        milestone: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          create: jest.fn().mockImplementation(async ({ data }) => {
            createdMilestones.push(data);
            return data;
          }),
        },
        job: {
          update: jest.fn().mockImplementation(async ({ data }) => {
            updatedJobData = data;
            return data;
          }),
        },
      };

      const mockPrisma = {
        $transaction: jest.fn(async (cb: (tx: unknown) => Promise<void>) => cb(mockTx)),
      } as unknown as PrismaClient;

      await ContractService.syncJobFromChain(mockPrisma, "job-942", "42");

      expect(updatedJobData).toEqual({
        budget: 21.2800003,
        budgetStroops: "212800003",
      });
      expect(createdMilestones).toHaveLength(3);
      expect(createdMilestones[0]).toMatchObject({
        amount: 0.29,
        amountStroops: "2900000",
      });
      expect(createdMilestones[1]).toMatchObject({
        amount: 19.99,
        amountStroops: "199900000",
      });
      expect(createdMilestones[2]).toMatchObject({
        amount: 1.0000003,
        amountStroops: "10000003",
      });

      // Now round-trip the synced milestones back through buildCreateJobTx and
      // buildProposeRevisionTx and verify the exact on-chain stroops are emitted:
      (nativeToScVal as jest.Mock).mockClear();
      await ContractService.buildCreateJobTx(
        "GCLIENT",
        "GFREELANCER",
        "CTOKEN",
        createdMilestones.map((m) => ({
          description: m.description,
          amount: m.amount,
          amountStroops: m.amountStroops,
          deadline: Math.floor(m.contractDeadline.getTime() / 1000),
        })),
        1_800_200_000,
      );

      expect(nativeToScVal).toHaveBeenCalledWith(["Phase 1", 2_900_000n, 1_800_000_000n]);
      expect(nativeToScVal).toHaveBeenCalledWith(["Phase 2", 199_900_000n, 1_800_086_400n]);
      expect(nativeToScVal).toHaveBeenCalledWith(["Phase 3", 10_000_003n, 1_800_172_800n]);

      (nativeToScVal as jest.Mock).mockClear();
      await ContractService.buildProposeRevisionTx(
        "GCLIENT",
        "42",
        createdMilestones.map((m) => ({
          description: m.description,
          amount: m.amount,
          deadlineUnix: Math.floor(m.contractDeadline.getTime() / 1000),
        })),
      );

      expect(nativeToScVal).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Phase 1",
          amount: 2_900_000n,
        }),
      );
      expect(nativeToScVal).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Phase 2",
          amount: 199_900_000n,
        }),
      );
      expect(nativeToScVal).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Phase 3",
          amount: 10_000_003n,
        }),
      );
    });
  });
});

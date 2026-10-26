jest.mock(
  "react",
  () => {
    try {
      return jest.requireActual("react");
    } catch {
      return {
        useState: (init: unknown) => [init, () => undefined],
        useRef: () => ({ current: null }),
        useEffect: () => undefined,
        createElement: () => null,
      };
    }
  },
  { virtual: true },
);

jest.mock(
  "lucide-react",
  () => ({
    X: () => null,
    AlertCircle: () => null,
    Loader2: () => null,
    Paperclip: () => null,
    Upload: () => null,
    Info: () => null,
  }),
  { virtual: true },
);

jest.mock(
  "axios",
  () => ({
    __esModule: true,
    default: { post: jest.fn() },
    AxiosError: class AxiosError extends Error {},
  }),
  { virtual: true },
);

jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({ signAndBroadcastTransaction: jest.fn() }),
}));

jest.mock("@/hooks/useFocusTrap", () => ({
  useFocusTrap: () => undefined,
}));

import {
  DEFAULT_MIN_VOTES,
  MIN_VOTES_CEILING,
  MIN_VOTES_FLOOR,
  sanitizeMinVotes,
} from "../RaiseDisputeModal";

describe("RaiseDisputeModal sanitizeMinVotes (#955)", () => {
  it("falls back to DEFAULT_MIN_VOTES (3) when the input is cleared or empty", () => {
    expect(sanitizeMinVotes("")).toBe(DEFAULT_MIN_VOTES);
    expect(sanitizeMinVotes("   ")).toBe(DEFAULT_MIN_VOTES);
  });

  it("falls back to DEFAULT_MIN_VOTES (3) when the input is non-numeric or NaN", () => {
    expect(sanitizeMinVotes("abc")).toBe(DEFAULT_MIN_VOTES);
    expect(sanitizeMinVotes(Number.NaN)).toBe(DEFAULT_MIN_VOTES);
    expect(sanitizeMinVotes(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MIN_VOTES);
    expect(sanitizeMinVotes(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MIN_VOTES);
  });

  it("clamps values below MIN_VOTES_FLOOR (3) to 3", () => {
    expect(sanitizeMinVotes("0")).toBe(MIN_VOTES_FLOOR);
    expect(sanitizeMinVotes("-5")).toBe(MIN_VOTES_FLOOR);
    expect(sanitizeMinVotes("2")).toBe(MIN_VOTES_FLOOR);
    expect(sanitizeMinVotes(1)).toBe(MIN_VOTES_FLOOR);
  });

  it("clamps values above MIN_VOTES_CEILING (21) to 21", () => {
    expect(sanitizeMinVotes("22")).toBe(MIN_VOTES_CEILING);
    expect(sanitizeMinVotes("999")).toBe(MIN_VOTES_CEILING);
    expect(sanitizeMinVotes(50)).toBe(MIN_VOTES_CEILING);
  });

  it("preserves valid integer values within [3, 21]", () => {
    expect(sanitizeMinVotes("3")).toBe(3);
    expect(sanitizeMinVotes("5")).toBe(5);
    expect(sanitizeMinVotes("21")).toBe(21);
    expect(sanitizeMinVotes(7)).toBe(7);
  });
});

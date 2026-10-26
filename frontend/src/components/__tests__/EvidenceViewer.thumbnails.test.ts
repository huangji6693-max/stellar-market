import * as fs from "fs";
import * as path from "path";

jest.mock("react", () => ({
  useState: jest.fn(),
  useEffect: jest.fn(),
  useCallback: jest.fn(),
  useRef: jest.fn(),
  createElement: jest.fn(),
}), { virtual: true });

jest.mock("lucide-react", () => ({
  File: "File",
  FileText: "FileText",
  Image: "Image",
  Play: "Play",
  Video: "Video",
  ExternalLink: "ExternalLink",
  Download: "Download",
  Shield: "Shield",
  ShieldAlert: "ShieldAlert",
  ShieldCheck: "ShieldCheck",
  Loader2: "Loader2",
  RefreshCw: "RefreshCw",
}), { virtual: true });

jest.mock("axios", () => ({ get: jest.fn() }), { virtual: true });
jest.mock("@/components/LocalTimestamp", () => () => null, { virtual: true });
jest.mock("@/components/EvidenceVideoPlayer", () => () => null, { virtual: true });
jest.mock("@/lib/mediaRecording", () => ({ isVideoEvidence: jest.fn() }), { virtual: true });
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}), { virtual: true });

import {
  getEvidenceMediaKind,
  getFileExtensionBadge,
} from "../EvidenceViewer";

describe("EvidenceViewer MIME type mapping & extension badges (#813)", () => {
  it("maps image/* MIME types to 'image' kind and emerald extension badge", () => {
    expect(getEvidenceMediaKind("image/jpeg")).toBe("image");
    expect(getEvidenceMediaKind("image/png")).toBe("image");
    const badge = getFileExtensionBadge("screenshot.jpg", "image/jpeg");
    expect(badge.ext).toBe(".jpg");
    expect(badge.className).toContain("text-emerald-500");
  });

  it("maps application/pdf to 'pdf' kind and red .pdf extension badge", () => {
    expect(getEvidenceMediaKind("application/pdf")).toBe("pdf");
    const badge = getFileExtensionBadge("contract.pdf", "application/pdf");
    expect(badge.ext).toBe(".pdf");
    expect(badge.className).toContain("text-red-500");
  });

  it("maps video/* MIME types to 'video' kind and blue .mp4 extension badge", () => {
    expect(getEvidenceMediaKind("video/mp4")).toBe("video");
    expect(getEvidenceMediaKind("video/webm")).toBe("video");
    const badge = getFileExtensionBadge("demo.mp4", "video/mp4");
    expect(badge.ext).toBe(".mp4");
    expect(badge.className).toContain("text-blue-500");
  });

  it("maps unknown MIME types to 'generic' kind and neutral badge", () => {
    expect(getEvidenceMediaKind("application/zip")).toBe("generic");
    expect(getEvidenceMediaKind("application/octet-stream")).toBe("generic");
    expect(getEvidenceMediaKind(undefined)).toBe("generic");
    const badge = getFileExtensionBadge("bundle.zip", "application/zip");
    expect(badge.ext).toBe(".zip");
    expect(badge.className).toContain("bg-slate-500/15");
  });

  it("renders 64x64 inline thumbnail and distinct icons in EvidenceViewer markup", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "EvidenceViewer.tsx"),
      "utf8",
    );
    expect(src).toContain('width={64}');
    expect(src).toContain('height={64}');
    expect(src).toContain('data-testid="evidence-thumbnail"');
    expect(src).toContain('data-testid="evidence-icon-image"');
    expect(src).toContain('data-testid="evidence-icon-pdf"');
    expect(src).toContain('data-testid="evidence-icon-video"');
    expect(src).toContain('data-testid="evidence-icon-generic"');
    expect(src).toContain('data-testid="evidence-ext-badge"');
  });
});

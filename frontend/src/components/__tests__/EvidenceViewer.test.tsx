import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import EvidenceViewer from "@/components/EvidenceViewer";

jest.mock("axios", () => ({ get: jest.fn() }));
const mockGet = axios.get as jest.Mock;

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}));

describe("EvidenceViewer", () => {
  beforeEach(() => {
    localStorage.setItem("token", "test-token");
    Object.defineProperty(URL, "createObjectURL", { value: jest.fn(() => "blob:download"), writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: jest.fn(), writable: true });
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mockGet.mockResolvedValue({ data: new Blob(["evidence"]) });
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("requests the protected signed-download endpoint", async () => {
    render(
      <EvidenceViewer
        disputeId="dispute-1"
        evidence={[{
          id: "evidence-1",
          fileName: "contract.pdf",
          fileType: "application/pdf",
          sizeFormatted: "42 KB",
          uploadedAt: "2026-01-01T00:00:00.000Z",
        }]}
      />,
    );

    expect(screen.getByText("application/pdf")).toBeInTheDocument();
    expect(screen.getByText("42 KB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download contract.pdf" }));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith(
        "http://localhost:5000/api/v1/disputes/dispute-1/evidence/evidence-1/download",
        expect.objectContaining({ responseType: "blob" }),
      );
    });
  });

  it("renders image icon, 64x64 inline thumbnail, and extension badge for JPEG attachments", () => {
    render(
      <EvidenceViewer
        disputeId="dispute-1"
        evidence={[{
          id: "evidence-img",
          fileName: "screenshot.jpg",
          fileType: "image/jpeg",
          url: "https://cdn.stellarmarket.test/screenshot.jpg",
          sizeFormatted: "128 KB",
          uploadedAt: "2026-01-01T00:00:00.000Z",
        }]}
      />,
    );

    expect(screen.getByTestId("evidence-icon-image")).toBeInTheDocument();
    const thumbnail = screen.getByTestId("evidence-thumbnail") as HTMLImageElement;
    expect(thumbnail).toBeInTheDocument();
    expect(thumbnail).toHaveAttribute("src", "https://cdn.stellarmarket.test/screenshot.jpg");
    expect(thumbnail).toHaveAttribute("width", "64");
    expect(thumbnail).toHaveAttribute("height", "64");
    expect(screen.getByTestId("evidence-ext-badge")).toHaveTextContent(".jpg");
  });

  it("renders PDF icon, red .pdf badge, and no thumbnail for PDF attachments", () => {
    render(
      <EvidenceViewer
        disputeId="dispute-1"
        evidence={[{
          id: "evidence-pdf",
          fileName: "invoice.pdf",
          fileType: "application/pdf",
          sizeFormatted: "64 KB",
          uploadedAt: "2026-01-01T00:00:00.000Z",
        }]}
      />,
    );

    expect(screen.getByTestId("evidence-icon-pdf")).toBeInTheDocument();
    expect(screen.queryByTestId("evidence-thumbnail")).not.toBeInTheDocument();
    const badge = screen.getByTestId("evidence-ext-badge");
    expect(badge).toHaveTextContent(".pdf");
    expect(badge.className).toContain("text-red-500");
  });

  it("renders play icon and blue .mp4 badge for video attachments", () => {
    render(
      <EvidenceViewer
        disputeId="dispute-1"
        evidence={[{
          id: "evidence-vid",
          fileName: "walkthrough.mp4",
          fileType: "video/mp4",
          sizeFormatted: "2.4 MB",
          uploadedAt: "2026-01-01T00:00:00.000Z",
        }]}
      />,
    );

    expect(screen.getByTestId("evidence-icon-video")).toBeInTheDocument();
    expect(screen.queryByTestId("evidence-thumbnail")).not.toBeInTheDocument();
    const badge = screen.getByTestId("evidence-ext-badge");
    expect(badge).toHaveTextContent(".mp4");
    expect(badge.className).toContain("text-blue-500");
  });

  it("renders generic file icon and extension badge for unknown MIME types", () => {
    render(
      <EvidenceViewer
        disputeId="dispute-1"
        evidence={[{
          id: "evidence-unknown",
          fileName: "archive.zip",
          fileType: "application/zip",
          sizeFormatted: "512 KB",
          uploadedAt: "2026-01-01T00:00:00.000Z",
        }]}
      />,
    );

    expect(screen.getByTestId("evidence-icon-generic")).toBeInTheDocument();
    expect(screen.queryByTestId("evidence-thumbnail")).not.toBeInTheDocument();
    expect(screen.getByTestId("evidence-ext-badge")).toHaveTextContent(".zip");
  });
});

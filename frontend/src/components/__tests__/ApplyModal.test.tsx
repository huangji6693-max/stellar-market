import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import ApplyModal from "../ApplyModal";

let mockTheme: "dark" | "light" = "light";

jest.mock("@/context/ThemeContext", () => ({
  useTheme: () => ({
    theme: mockTheme,
    toggleTheme: jest.fn(),
  }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "mock-token", user: { id: "u1" } }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}));

jest.mock("@/hooks/useFocusTrap", () => ({
  useFocusTrap: () => undefined,
}));

jest.mock("next/dynamic", () => () => () => <div data-testid="mock-md-editor" />);

const mockJob = {
  id: "job-1",
  title: "Frontend Developer",
  budget: 500,
  status: "OPEN",
  category: "Engineering",
  skills: ["React", "TypeScript"],
  deadline: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  client: { id: "c1", username: "client1", walletAddress: "GCLIENT" },
  freelancer: null,
} as any;

describe("ApplyModal cover letter editor theme (#1333)", () => {
  it("sets data-color-mode='light' when active theme is light", () => {
    mockTheme = "light";
    render(
      <ApplyModal
        job={mockJob}
        isOpen={true}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />
    );

    const editorWrapper = screen.getByRole("textbox", {
      name: /cover letter editor/i,
    });
    expect(editorWrapper).toHaveAttribute("data-color-mode", "light");
  });

  it("sets data-color-mode='dark' when active theme is dark", () => {
    mockTheme = "dark";
    render(
      <ApplyModal
        job={mockJob}
        isOpen={true}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />
    );

    const editorWrapper = screen.getByRole("textbox", {
      name: /cover letter editor/i,
    });
    expect(editorWrapper).toHaveAttribute("data-color-mode", "dark");
  });
});

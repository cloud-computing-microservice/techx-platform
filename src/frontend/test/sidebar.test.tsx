import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Sidebar from "@/components/layout/Sidebar";
import { CONTENT } from "@/lib/site-config";
import { categoryFixture } from "./fixtures";

function FilterHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-controls="product-filters"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Open filters
      </button>
      <Sidebar
        categories={[categoryFixture]}
        selectedCategory=""
        selectedPrice=""
        selectedAvailability=""
        onCategoryChange={() => undefined}
        onPriceChange={() => undefined}
        onAvailabilityChange={() => undefined}
        onClear={() => undefined}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("filter drawer keyboard navigation", () => {
  it("traps Tab while open and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);
    const trigger = screen.getByRole("button", { name: "Open filters" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("complementary", {
      name: CONTENT.catalog.productFilters,
    });
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    const first = document.activeElement;
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: CONTENT.catalog.applyFilters }),
    ).toHaveFocus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");
  });
});

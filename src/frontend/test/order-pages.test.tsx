import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrderConfirmationPage from "@/app/order/[id]/page";
import OrdersPage from "@/app/orders/page";
import { ApiClientError } from "@/lib/api-client";
import type * as ApiClientModule from "@/lib/api-client";
import { CONTENT, UI_STORAGE_KEYS } from "@/lib/site-config";
import { orderFixture } from "./fixtures";

const mocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: orderFixture.id }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, getOrder: mocks.getOrder };
});

describe("order pages", () => {
  beforeEach(() => mocks.getOrder.mockReset());

  it("renders a non-expired confirmation cache when lookup is unavailable", async () => {
    const cached = {
      ...orderFixture,
      expiresAt: "2099-08-07T13:00:00.000Z",
    };
    window.sessionStorage.setItem(
      UI_STORAGE_KEYS.lastOrder,
      JSON.stringify(cached),
    );
    mocks.getOrder.mockRejectedValueOnce(
      new ApiClientError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
    );

    render(<OrderConfirmationPage />);

    expect(await screen.findByText(cached.id)).toBeInTheDocument();
    expect(screen.getByText(cached.customer.emailMasked)).toBeInTheDocument();
  });

  it("validates lookup ids locally and presents a typed not-found error", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);
    const input = screen.getByLabelText(CONTENT.order.id);

    await user.type(input, "invalid");
    await user.click(
      screen.getByRole("button", { name: CONTENT.order.lookupAction }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      CONTENT.order.invalidId,
    );
    expect(mocks.getOrder).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, orderFixture.id);
    mocks.getOrder.mockRejectedValueOnce(
      new ApiClientError(404, "ORDER_NOT_FOUND", "Not found"),
    );
    await user.click(
      screen.getByRole("button", { name: CONTENT.order.lookupAction }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The order was not found or has expired.",
      ),
    );
  });
});

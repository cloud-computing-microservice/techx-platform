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

  it("clears the invalid state as soon as the user edits the order id", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);
    const input = screen.getByLabelText(CONTENT.order.id);

    await user.type(input, "invalid");
    await user.click(
      screen.getByRole("button", { name: CONTENT.order.lookupAction }),
    );
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.type(input, "x");
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a loading state while looking up an order", async () => {
    const user = userEvent.setup();
    let resolveLookup: (value: { order: typeof orderFixture }) => void = () =>
      undefined;
    mocks.getOrder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    render(<OrdersPage />);

    await user.type(screen.getByLabelText(CONTENT.order.id), orderFixture.id);
    await user.click(
      screen.getByRole("button", { name: CONTENT.order.lookupAction }),
    );

    expect(
      screen.getByRole("button", { name: CONTENT.order.lookingUp }),
    ).toBeDisabled();

    resolveLookup({ order: orderFixture });
    expect(
      await screen.findByLabelText(CONTENT.order.detailsLabel),
    ).toBeInTheDocument();
    expect(
      screen.getByText(orderFixture.customer.emailMasked),
    ).toBeInTheDocument();
  });

  it("retries a failed confirmation load without losing the page", async () => {
    const user = userEvent.setup();
    mocks.getOrder
      .mockRejectedValueOnce(
        new ApiClientError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
      )
      .mockResolvedValueOnce({ order: orderFixture });

    render(<OrderConfirmationPage />);

    expect(
      await screen.findByRole("heading", { name: CONTENT.order.unavailable }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: CONTENT.common.retry }),
    );

    expect(
      await screen.findByText(orderFixture.customer.emailMasked),
    ).toBeInTheDocument();
    expect(mocks.getOrder).toHaveBeenCalledTimes(2);
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

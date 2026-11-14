import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CheckoutPage from "@/app/checkout/page";
import { CartProvider } from "@/lib/CartContext";
import type * as ApiClientModule from "@/lib/api-client";
import { loadCart, saveCart } from "@/lib/cart";
import { EMPTY_CHECKOUT_FORM } from "@/lib/checkout";
import { CONTENT, UI_STORAGE_KEYS } from "@/lib/site-config";
import type { CatalogCategory, Product, StoreConfig } from "@/lib/types";
import {
  categoryFixture,
  configFixture,
  orderFixture,
  productFixture,
} from "./fixtures";

const nav = vi.hoisted(() => ({ push: vi.fn() }));

const store = vi.hoisted(() => ({
  products: [] as Product[],
  categories: [] as CatalogCategory[],
  config: null as StoreConfig | null,
  catalogState: "success" as "loading" | "success" | "error",
  configState: "success" as "loading" | "success" | "error",
  retryCatalog: vi.fn(),
  retryConfig: vi.fn(),
}));

const api = vi.hoisted(() => ({ createOrder: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
}));

vi.mock("@/lib/StorefrontContext", () => ({
  useStorefront: () => store,
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, createOrder: api.createOrder };
});

const validForm = {
  ...EMPTY_CHECKOUT_FORM,
  email: "test@example.com",
  name: "Test Customer",
  line1: "100 Test Street",
  city: "Seattle",
  region: "WA",
  postalCode: "98101",
};

async function fillCheckoutForm() {
  const user = userEvent.setup();
  for (const [label, value] of [
    ["Email address", validForm.email],
    ["Full name", validForm.name],
    ["Street address", validForm.line1],
    ["City", validForm.city],
    ["State", validForm.region],
    ["ZIP code", validForm.postalCode],
  ] as const) {
    await user.type(screen.getByLabelText(label), value);
  }
  return user;
}

function renderCheckout() {
  saveCart(window.sessionStorage, [{ product: productFixture, quantity: 1 }]);
  return render(
    <CartProvider>
      <CheckoutPage />
    </CartProvider>,
  );
}

describe("checkout page", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    nav.push.mockReset();
    api.createOrder.mockReset();
    store.products = [productFixture];
    store.categories = [categoryFixture];
    store.config = configFixture;
    store.catalogState = "success";
    store.configState = "success";
  });

  it("shows an empty state when there is nothing to check out", () => {
    render(
      <CartProvider>
        <CheckoutPage />
      </CartProvider>,
    );

    expect(screen.getByText(CONTENT.checkout.emptyTitle)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: CONTENT.common.shopNow }),
    ).toBeInTheDocument();
  });

  it("validates required fields, focuses the first error, and clears errors on edit", async () => {
    const user = userEvent.setup();
    renderCheckout();

    await user.click(
      await screen.findByRole("button", { name: CONTENT.checkout.placeOrder }),
    );

    expect(screen.getByText(CONTENT.checkout.validation.email)).toBeVisible();
    expect(screen.getByText(CONTENT.checkout.validation.name)).toBeVisible();
    expect(
      screen.getByText(CONTENT.checkout.validation.postalCode),
    ).toBeVisible();
    expect(screen.getByText(CONTENT.checkout.retryHint)).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveFocus();
    expect(api.createOrder).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    expect(
      screen.queryByText(CONTENT.checkout.validation.email),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["DEPENDENCY_UNAVAILABLE", /temporarily unavailable/i],
    ["BFF_NOT_READY", /orders are temporarily unavailable/i],
    ["UNEXPECTED_ERROR", /review the information/i],
  ] as const)(
    "keeps the form available after %s",
    async (code, expectedMessage) => {
      const user = userEvent.setup();
      const { ApiClientError } = await import("@/lib/api-client");
      api.createOrder.mockRejectedValueOnce(
        new ApiClientError(503, code, "Dependency unavailable"),
      );
      renderCheckout();
      await screen.findByRole("heading", { name: CONTENT.checkout.contact });
      await fillCheckoutForm();

      await user.click(
        screen.getByRole("button", { name: CONTENT.checkout.placeOrder }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        expectedMessage,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        CONTENT.checkout.submitErrorSuffix,
      );
      expect(
        screen.getByRole("button", { name: CONTENT.checkout.placeOrder }),
      ).toBeEnabled();
    },
  );

  it("submits a valid order and clears the cart", async () => {
    const user = userEvent.setup();
    api.createOrder.mockResolvedValueOnce({
      order: orderFixture,
      idempotentReplay: false,
    });
    renderCheckout();
    await screen.findByRole("heading", { name: CONTENT.checkout.contact });
    await fillCheckoutForm();

    await user.click(
      screen.getByRole("button", { name: CONTENT.checkout.placeOrder }),
    );

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(`/order/${orderFixture.id}`),
    );
    expect(window.sessionStorage.getItem(UI_STORAGE_KEYS.lastOrder)).toContain(
      orderFixture.id,
    );
    expect(loadCart(window.sessionStorage)).toEqual([]);
  });

  it("disables the form during submission and preserves input for retry", async () => {
    let rejectOrder: (error: Error) => void = () => undefined;
    api.createOrder.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOrder = reject;
      }),
    );
    renderCheckout();
    await screen.findByRole("heading", { name: CONTENT.checkout.contact });
    const user = await fillCheckoutForm();
    await user.click(
      screen.getByRole("button", { name: CONTENT.checkout.placeOrder }),
    );

    expect(screen.getByLabelText("Email address")).toBeDisabled();
    expect(
      screen.getByLabelText("Email address").closest("form"),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: CONTENT.checkout.submitting }),
    ).toBeDisabled();
    expect(api.createOrder).toHaveBeenCalledTimes(1);

    rejectOrder(new Error("Offline"));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Email address")).toBeEnabled();
    expect(screen.getByLabelText("Email address")).toHaveValue(validForm.email);
    expect(loadCart(window.sessionStorage)).toHaveLength(1);

    api.createOrder.mockResolvedValueOnce({
      order: orderFixture,
      idempotentReplay: false,
    });
    await user.click(
      screen.getByRole("button", { name: CONTENT.checkout.placeOrder }),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    // Retrying an unchanged checkout must reuse the idempotency key.
    expect(api.createOrder.mock.calls[1]).toEqual(
      api.createOrder.mock.calls[0],
    );
  });
});

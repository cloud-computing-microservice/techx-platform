import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CartPage from "@/app/cart/page";
import { CartProvider } from "@/lib/CartContext";
import { loadCart, saveCart } from "@/lib/cart";
import { CONTENT } from "@/lib/site-config";
import type { CatalogCategory, Product, StoreConfig } from "@/lib/types";
import { categoryFixture, configFixture, productFixture } from "./fixtures";

const store = vi.hoisted(() => ({
  products: [] as Product[],
  categories: [] as CatalogCategory[],
  config: null as StoreConfig | null,
  catalogState: "success" as "loading" | "success" | "error",
  configState: "success" as "loading" | "success" | "error",
  retryCatalog: vi.fn(),
  retryConfig: vi.fn(),
}));

vi.mock("@/lib/StorefrontContext", () => ({
  useStorefront: () => store,
}));

describe("cart page", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    store.products = [productFixture];
    store.categories = [categoryFixture];
    store.config = configFixture;
    store.catalogState = "success";
    store.configState = "success";
  });

  it("shows an empty state with a path back to the catalog", () => {
    render(
      <CartProvider>
        <CartPage />
      </CartProvider>,
    );

    expect(screen.getByText(CONTENT.cart.empty)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: CONTENT.common.shopNow }),
    ).toHaveAttribute("href", "/products");
  });

  it("changes quantities and removes a line item", async () => {
    const user = userEvent.setup();
    saveCart(window.sessionStorage, [{ product: productFixture, quantity: 1 }]);
    render(
      <CartProvider>
        <CartPage />
      </CartProvider>,
    );

    expect(await screen.findByText(productFixture.name)).toBeInTheDocument();
    expect(screen.getByText(CONTENT.cart.count(1))).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: CONTENT.common.increaseQuantity }),
    );
    expect(screen.getByText(CONTENT.cart.count(2))).toBeInTheDocument();
    await waitFor(() =>
      expect(loadCart(window.sessionStorage)[0]?.quantity).toBe(2),
    );

    await user.click(
      screen.getByRole("button", {
        name: CONTENT.cart.removeItem(productFixture.name),
      }),
    );
    expect(screen.getByText(CONTENT.cart.empty)).toBeInTheDocument();
    expect(loadCart(window.sessionStorage)).toEqual([]);
  });

  it("blocks checkout when a cart item is unavailable", () => {
    const unavailable = {
      ...productFixture,
      availability: "out_of_stock" as const,
    };
    store.products = [unavailable];
    saveCart(window.sessionStorage, [{ product: unavailable, quantity: 1 }]);

    render(
      <CartProvider>
        <CartPage />
      </CartProvider>,
    );

    expect(screen.getByText(CONTENT.cart.unavailableItems)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONTENT.cart.checkout }),
    ).not.toBeInTheDocument();
  });
});

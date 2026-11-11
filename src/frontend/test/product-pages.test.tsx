import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductDetailPage from "@/app/product/[id]/page";
import { CartProvider } from "@/lib/CartContext";
import { loadCart } from "@/lib/cart";
import { CONTENT } from "@/lib/site-config";
import { categoryFixture, configFixture, productFixture } from "./fixtures";

const store = vi.hoisted(() => ({
  products: [] as (typeof productFixture)[],
  categories: [] as (typeof categoryFixture)[],
  config: null as typeof configFixture | null,
  catalogState: "loading" as "loading" | "success" | "error",
  configState: "success" as "loading" | "success" | "error",
  retryCatalog: vi.fn(),
  retryConfig: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: productFixture.id }),
}));

vi.mock("@/lib/StorefrontContext", () => ({
  useStorefront: () => store,
}));

describe("product detail page", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    store.products = [productFixture];
    store.categories = [categoryFixture];
    store.config = configFixture;
    store.catalogState = "success";
    store.retryCatalog.mockReset();
  });

  it("shows a catalog error state with a retry action", async () => {
    const user = userEvent.setup();
    store.products = [];
    store.categories = [];
    store.catalogState = "error";

    render(
      <CartProvider>
        <ProductDetailPage />
      </CartProvider>,
    );

    expect(
      screen.getByRole("heading", { name: CONTENT.product.loadErrorTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(CONTENT.product.loadErrorBody)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: CONTENT.common.retry }),
    );
    expect(store.retryCatalog).toHaveBeenCalledTimes(1);
  });

  it("adds the selected quantity to the cart", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider>
        <ProductDetailPage />
      </CartProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: CONTENT.common.increaseQuantity }),
    );
    await user.click(
      screen.getByRole("button", { name: CONTENT.common.addToCart }),
    );

    expect(
      screen.getByRole("button", { name: CONTENT.common.added }),
    ).toBeDisabled();
    await waitFor(() =>
      expect(loadCart(window.sessionStorage)).toEqual([
        { product: productFixture, quantity: 2 },
      ]),
    );
  });

  it("explains when a product no longer exists", () => {
    store.products = [];
    render(
      <CartProvider>
        <ProductDetailPage />
      </CartProvider>,
    );

    expect(
      screen.getByRole("heading", { name: CONTENT.product.notFound }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: CONTENT.common.shopNow }),
    ).toHaveAttribute("href", "/products");
  });
});

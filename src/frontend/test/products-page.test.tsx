import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductsPage from "@/app/products/page";
import { CartProvider } from "@/lib/CartContext";
import { CONTENT } from "@/lib/site-config";
import type { CatalogCategory, Product, StoreConfig } from "@/lib/types";
import { categoryFixture, productFixture } from "./fixtures";

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

const store = vi.hoisted(() => ({
  products: [] as Product[],
  categories: [] as CatalogCategory[],
  config: null as StoreConfig | null,
  catalogState: "success" as "loading" | "success" | "error",
  configState: "success" as "loading" | "success" | "error",
  retryCatalog: vi.fn(),
  retryConfig: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace }),
}));

vi.mock("@/lib/StorefrontContext", () => ({
  useStorefront: () => store,
}));

const binocularFixture: Product = {
  ...productFixture,
  id: "night-binocular",
  sku: "TEST-002",
  name: "Night Test 10x50",
  shortDescription: "A portable test binocular.",
  category: "binoculars",
  priceCents: 7_900,
  featured: false,
  tags: ["stargazing", "portable"],
  images: [{ src: "/products/test-binocular.svg", alt: "Test binocular" }],
};

describe("product catalog page", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockReset();
    store.products = [productFixture, binocularFixture];
    store.categories = [
      categoryFixture,
      {
        id: "binoculars",
        label: "Binoculars",
        description: "Test binocular category",
        count: 1,
      },
    ];
    store.catalogState = "success";
    store.retryCatalog.mockReset();
  });

  it("applies search and category filters from the URL", () => {
    nav.search = "?category=binoculars&q=night";
    render(
      <CartProvider>
        <ProductsPage />
      </CartProvider>,
    );

    expect(screen.getByText(binocularFixture.name)).toBeInTheDocument();
    expect(screen.queryByText(productFixture.name)).not.toBeInTheDocument();
    expect(
      screen.getByText(CONTENT.catalog.resultCount(1)),
    ).toBeInTheDocument();
  });

  it("submits a search query without reloading the page", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider>
        <ProductsPage />
      </CartProvider>,
    );

    await user.type(
      screen.getByLabelText(CONTENT.catalog.searchLabel),
      "  orion  ",
    );
    await user.click(
      screen.getByRole("button", { name: CONTENT.common.search }),
    );

    expect(nav.replace).toHaveBeenCalledWith("/products?q=orion", {
      scroll: false,
    });
  });

  it("offers a clear action when no products match", async () => {
    const user = userEvent.setup();
    nav.search = "?q=not-a-real-product";
    render(
      <CartProvider>
        <ProductsPage />
      </CartProvider>,
    );

    expect(screen.getByText(CONTENT.catalog.noResults)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: CONTENT.catalog.clear }),
    );
    expect(nav.replace).toHaveBeenCalledWith("/products", { scroll: false });
  });

  it("shows skeletons while loading and a retryable error state", async () => {
    const user = userEvent.setup();
    store.catalogState = "loading";
    const { rerender } = render(
      <CartProvider>
        <ProductsPage />
      </CartProvider>,
    );

    expect(
      screen.getByLabelText(CONTENT.catalog.loadingProducts),
    ).toBeInTheDocument();

    store.catalogState = "error";
    rerender(
      <CartProvider>
        <ProductsPage />
      </CartProvider>,
    );
    expect(
      screen.getByRole("heading", { name: CONTENT.catalog.errorTitle }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: CONTENT.common.retry }),
    );
    expect(store.retryCatalog).toHaveBeenCalledTimes(1);
  });
});

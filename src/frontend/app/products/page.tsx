"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import ProductGrid from "@/components/product/ProductGrid";
import Icon from "@/components/ui/Icon";
import {
  DEFAULT_CATALOG_FILTERS,
  filterAndSortProducts,
  type CatalogFilters,
  type PriceFilterId,
  type SortId,
} from "@/lib/catalog";
import {
  CONTENT,
  PRICE_FILTERS,
  ROUTES,
  SORT_OPTIONS,
} from "@/lib/site-config";
import { useStorefront } from "@/lib/StorefrontContext";
import {
  AVAILABILITY_VALUES,
  PRODUCT_CATEGORY_VALUES,
  type Availability,
  type ProductCategory,
} from "@/lib/types";

function validCategory(value: string | null): ProductCategory | "" {
  return PRODUCT_CATEGORY_VALUES.includes(value as ProductCategory)
    ? (value as ProductCategory)
    : "";
}

function validAvailability(value: string | null): Availability | "" {
  return AVAILABILITY_VALUES.includes(value as Availability)
    ? (value as Availability)
    : "";
}

function validPrice(value: string | null): PriceFilterId {
  return PRICE_FILTERS.some((price) => price.id === value)
    ? (value as PriceFilterId)
    : "";
}

function validSort(value: string | null): SortId {
  return SORT_OPTIONS.some((option) => option.id === value)
    ? (value as SortId)
    : DEFAULT_CATALOG_FILTERS.sort;
}

function ProductsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { products, categories, catalogState, retryCatalog } = useStorefront();
  const [queryDraft, setQueryDraft] = useState(searchParams.get("q") ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filters: CatalogFilters = useMemo(
    () => ({
      query: searchParams.get("q") ?? "",
      category: validCategory(searchParams.get("category")),
      price: validPrice(searchParams.get("price")),
      availability: validAvailability(searchParams.get("availability")),
      sort: validSort(searchParams.get("sort")),
    }),
    [searchParams],
  );

  useEffect(() => setQueryDraft(filters.query), [filters.query]);

  function updateFilters(patch: Partial<CatalogFilters>) {
    const next = { ...filters, ...patch };
    const params = new URLSearchParams();
    if (next.query.trim()) params.set("q", next.query.trim());
    if (next.category) params.set("category", next.category);
    if (next.price) params.set("price", next.price);
    if (next.availability) params.set("availability", next.availability);
    if (next.sort !== DEFAULT_CATALOG_FILTERS.sort)
      params.set("sort", next.sort);
    const query = params.toString();
    router.replace(query ? `${ROUTES.products}?${query}` : ROUTES.products, {
      scroll: false,
    });
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    updateFilters({ query: queryDraft });
  }

  function clearFilters() {
    setQueryDraft("");
    router.replace(ROUTES.products, { scroll: false });
  }

  const visibleProducts = useMemo(
    () => filterAndSortProducts(products, filters),
    [filters, products],
  );
  const activeFilterCount = [
    filters.category,
    filters.price,
    filters.availability,
  ].filter(Boolean).length;

  return (
    <div className="catalog-page section-shell">
      <header className="catalog-heading">
        <p className="eyebrow">{CONTENT.catalog.eyebrow}</p>
        <h1>{CONTENT.catalog.title}</h1>
        <p>{CONTENT.catalog.intro}</p>
      </header>
      <form className="catalog-search" role="search" onSubmit={submitSearch}>
        <Icon name="search" />
        <label className="sr-only" htmlFor="catalog-search">
          {CONTENT.catalog.searchLabel}
        </label>
        <input
          id="catalog-search"
          type="search"
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          placeholder={CONTENT.catalog.searchPlaceholder}
        />
        {queryDraft && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setQueryDraft("");
              updateFilters({ query: "" });
            }}
          >
            {CONTENT.common.clear}
          </button>
        )}
        <button className="btn btn-primary" type="submit">
          {CONTENT.common.search}
        </button>
      </form>
      <div className="catalog-toolbar">
        <div>
          <button
            className="btn btn-secondary filter-toggle"
            type="button"
            onClick={() => setFiltersOpen(true)}
          >
            <Icon name="menu" size={17} />
            {CONTENT.catalog.filters}
            {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
          </button>
          <p aria-live="polite">
            {CONTENT.catalog.resultCount(visibleProducts.length)}
          </p>
        </div>
        <label>
          <span>{CONTENT.catalog.sortBy}</span>
          <select
            value={filters.sort}
            onChange={(event) =>
              updateFilters({ sort: event.target.value as SortId })
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="catalog-layout">
        <Sidebar
          categories={categories}
          selectedCategory={filters.category}
          selectedPrice={filters.price}
          selectedAvailability={filters.availability}
          onCategoryChange={(category) => updateFilters({ category })}
          onPriceChange={(price) => updateFilters({ price })}
          onAvailabilityChange={(availability) =>
            updateFilters({ availability })
          }
          onClear={clearFilters}
          isOpen={filtersOpen}
          onClose={() => setFiltersOpen(false)}
        />
        <div className="catalog-results">
          {catalogState === "error" ? (
            <div className="inline-error" role="alert">
              <h2>{CONTENT.catalog.errorTitle}</h2>
              <p>{CONTENT.catalog.errorBody}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={retryCatalog}
              >
                {CONTENT.common.retry}
              </button>
            </div>
          ) : (
            <ProductGrid
              products={visibleProducts}
              loading={catalogState === "loading"}
              emptyTitle={CONTENT.catalog.noResults}
              emptyDesc={CONTENT.catalog.noResultsBody}
              emptyAction={CONTENT.catalog.clear}
              onEmptyAction={clearFilters}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <div className="page-loading" aria-busy="true">
          {CONTENT.common.loading}
        </div>
      }
    >
      <ProductsContent />
    </Suspense>
  );
}

"use client";

import { useRef } from "react";
import Icon from "@/components/ui/Icon";
import {
  AVAILABILITY_CONTENT,
  AVAILABILITY_FILTERS,
  CATEGORY_PRESENTATION,
  CONTENT,
  PRICE_FILTERS,
} from "@/lib/site-config";
import type { PriceFilterId } from "@/lib/catalog";
import type {
  Availability,
  CatalogCategory,
  ProductCategory,
} from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";

interface SidebarProps {
  categories: CatalogCategory[];
  selectedCategory: ProductCategory | "";
  selectedPrice: PriceFilterId;
  selectedAvailability: Availability | "";
  onCategoryChange: (value: ProductCategory | "") => void;
  onPriceChange: (value: PriceFilterId) => void;
  onAvailabilityChange: (value: Availability | "") => void;
  onClear: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(props.isOpen, panelRef, props.onClose);
  const hasFilters = Boolean(
    props.selectedCategory || props.selectedPrice || props.selectedAvailability,
  );

  return (
    <>
      <button
        type="button"
        className={`filter-backdrop${props.isOpen ? " open" : ""}`}
        onClick={props.onClose}
        aria-label={CONTENT.catalog.closeProductFilters}
        tabIndex={props.isOpen ? 0 : -1}
      />
      <aside
        ref={panelRef}
        className={`filter-panel${props.isOpen ? " open" : ""}`}
        aria-label={CONTENT.catalog.productFilters}
      >
        <div className="filter-panel-head">
          <h2>{CONTENT.catalog.filters}</h2>
          <button
            className="icon-button filter-close"
            type="button"
            onClick={props.onClose}
            aria-label={CONTENT.catalog.closeFilters}
          >
            <Icon name="close" />
          </button>
        </div>

        <fieldset>
          <legend>{CONTENT.catalog.categories}</legend>
          <button
            type="button"
            className={
              !props.selectedCategory ? "filter-option active" : "filter-option"
            }
            onClick={() => props.onCategoryChange("")}
          >
            <span>{CONTENT.catalog.allProducts}</span>
            <span>
              {props.categories.reduce(
                (sum, category) => sum + category.count,
                0,
              )}
            </span>
          </button>
          {props.categories.map((category) => (
            <button
              type="button"
              key={category.id}
              className={
                props.selectedCategory === category.id
                  ? "filter-option active"
                  : "filter-option"
              }
              onClick={() => props.onCategoryChange(category.id)}
            >
              <span>
                <Icon
                  name={
                    CATEGORY_PRESENTATION[category.id].icon as
                      "scope" | "binoculars" | "accessories"
                  }
                  size={17}
                />
                {category.label}
              </span>
              <span>{category.count}</span>
            </button>
          ))}
        </fieldset>

        <fieldset>
          <legend>{CONTENT.catalog.price}</legend>
          {PRICE_FILTERS.map((price) => (
            <button
              type="button"
              key={price.id}
              className={
                props.selectedPrice === price.id
                  ? "filter-option active"
                  : "filter-option"
              }
              onClick={() =>
                props.onPriceChange(
                  props.selectedPrice === price.id ? "" : price.id,
                )
              }
            >
              <span>{price.label}</span>
            </button>
          ))}
        </fieldset>

        <fieldset>
          <legend>{CONTENT.catalog.availability}</legend>
          {AVAILABILITY_FILTERS.map((value) => (
            <button
              type="button"
              key={value}
              className={
                props.selectedAvailability === value
                  ? "filter-option active"
                  : "filter-option"
              }
              onClick={() =>
                props.onAvailabilityChange(
                  props.selectedAvailability === value ? "" : value,
                )
              }
            >
              <span>{AVAILABILITY_CONTENT[value].label}</span>
            </button>
          ))}
        </fieldset>

        <div className="filter-panel-actions">
          {hasFilters && (
            <button
              type="button"
              className="text-button"
              onClick={props.onClear}
            >
              {CONTENT.catalog.clear}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={props.onClose}
          >
            {CONTENT.catalog.applyFilters}
          </button>
        </div>
      </aside>
    </>
  );
}

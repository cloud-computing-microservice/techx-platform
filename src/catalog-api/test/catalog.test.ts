import assert from "node:assert/strict";
import { test } from "node:test";
import productsJson from "../data/products.json" with { type: "json" };
import { buildCategories, validateProducts } from "../src/catalog.js";

test("validates the complete v2 seed and derives category facets", () => {
  const products = validateProducts(productsJson);
  assert.equal(products.length, 24);
  assert.equal(products.filter((product) => product.featured).length, 7);
  assert.equal(
    products.filter((product) => product.compareAtPriceCents !== undefined)
      .length,
    3,
  );
  assert.equal(
    products.filter((product) => product.availability === "out_of_stock")
      .length,
    1,
  );
  assert.deepEqual(
    buildCategories(products).map(({ id, count }) => ({ id, count })),
    [
      { id: "telescopes", count: 8 },
      { id: "binoculars", count: 7 },
      { id: "accessories", count: 9 },
    ],
  );
});

test("fails fast for duplicate ids and inconsistent inventory", () => {
  const duplicate = [
    productsJson[0]!,
    { ...productsJson[1]!, id: productsJson[0]!.id },
  ];
  assert.throws(() => validateProducts(duplicate), /Duplicate product id/);

  const inconsistent = [
    { ...productsJson[0]!, availability: "out_of_stock", inventoryQuantity: 2 },
  ];
  assert.throws(() => validateProducts(inconsistent), /inventory must be zero/);
});

test("fails fast for duplicate skus", () => {
  const duplicateSku = [
    productsJson[0]!,
    { ...productsJson[1]!, sku: productsJson[0]!.sku },
  ];
  assert.throws(() => validateProducts(duplicateSku), /Duplicate product sku/);
});

test("rejects products with invalid category", () => {
  const bad = [{ ...productsJson[0]!, category: "invalid-category" }];
  assert.throws(() => validateProducts(bad), /category is invalid/);
});

test("rejects products with invalid availability", () => {
  const bad = [{ ...productsJson[0]!, availability: "discontinued" }];
  assert.throws(() => validateProducts(bad), /availability is invalid/);
});

test("rejects out-of-stock product with positive inventory", () => {
  const bad = [
    { ...productsJson[0]!, availability: "out_of_stock", inventoryQuantity: 1 },
  ];
  assert.throws(() => validateProducts(bad), /inventory must be zero/);
});

test("rejects in-stock product with zero inventory", () => {
  const bad = [
    { ...productsJson[0]!, availability: "in_stock", inventoryQuantity: 0 },
  ];
  assert.throws(
    () => validateProducts(bad),
    /available inventory must be positive/,
  );
});

test("rejects low-stock product with inventory > 5", () => {
  const bad = [
    { ...productsJson[0]!, availability: "low_stock", inventoryQuantity: 6 },
  ];
  assert.throws(
    () => validateProducts(bad),
    /low-stock inventory cannot exceed five/,
  );
});

test("rejects products with non-USD currency", () => {
  const bad = [{ ...productsJson[0]!, currency: "EUR" }];
  assert.throws(() => validateProducts(bad), /currency must be USD/);
});

test("rejects products with non-slug ids", () => {
  const bad = [{ ...productsJson[0]!, id: "Invalid ID!" }];
  assert.throws(() => validateProducts(bad), /must be a lowercase slug/);
});

test("rejects products with fewer than three specifications", () => {
  const bad = [
    {
      ...productsJson[0]!,
      specifications: [{ label: "Only", value: "One" }],
    },
  ];
  assert.throws(
    () => validateProducts(bad),
    /specifications must contain at least three rows/,
  );
});

test("rejects products with no images", () => {
  const bad = [{ ...productsJson[0]!, images: [] }];
  assert.throws(
    () => validateProducts(bad),
    /images must contain between one and four images/,
  );
});

test("rejects images with non-local src", () => {
  const bad = [
    {
      ...productsJson[0]!,
      images: [{ src: "https://external.com/img.png", alt: "External" }],
    },
  ];
  assert.throws(() => validateProducts(bad), /must use a local product asset/);
});

test("rejects compareAtPriceCents equal to or below priceCents", () => {
  const equal = [
    {
      ...productsJson[0]!,
      compareAtPriceCents: productsJson[0]!.priceCents,
    },
  ];
  assert.throws(() => validateProducts(equal), /compareAtPriceCents/);

  const below = [
    {
      ...productsJson[0]!,
      compareAtPriceCents: productsJson[0]!.priceCents - 1,
    },
  ];
  assert.throws(() => validateProducts(below), /compareAtPriceCents/);
});

test("accepts compareAtPriceCents strictly above priceCents", () => {
  const good = [
    {
      ...productsJson[0]!,
      id: "valid-compare-at",
      sku: "VALID-SKU-COMPARE",
      compareAtPriceCents: productsJson[0]!.priceCents + 1,
    },
  ];
  const products = validateProducts(good);
  assert.equal(
    products[0]!.compareAtPriceCents,
    productsJson[0]!.priceCents + 1,
  );
});

test("rejects empty product array", () => {
  assert.throws(() => validateProducts([]), /at least one product/);
});

test("buildCategories returns categories in the declared order", () => {
  const products = validateProducts(productsJson);
  const categories = buildCategories(products);
  assert.deepEqual(
    categories.map((c) => c.id),
    ["telescopes", "binoculars", "accessories"],
  );
});

test("buildCategories includes label and description for each category", () => {
  const products = validateProducts(productsJson);
  const categories = buildCategories(products);
  for (const category of categories) {
    assert.ok(typeof category.label === "string" && category.label.length > 0);
    assert.ok(
      typeof category.description === "string" &&
        category.description.length > 0,
    );
  }
});

test("seed products are frozen (immutable)", () => {
  const products = validateProducts(productsJson);
  assert.ok(Object.isFrozen(products[0]), "product objects should be frozen");
});

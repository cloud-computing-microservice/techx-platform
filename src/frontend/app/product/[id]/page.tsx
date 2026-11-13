"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ProductGrid from "@/components/product/ProductGrid";
import Badge from "@/components/ui/Badge";
import Icon from "@/components/ui/Icon";
import QuantityStepper from "@/components/ui/QuantityStepper";
import { relatedProducts } from "@/lib/catalog";
import { useCart } from "@/lib/CartContext";
import { discountPercent, formatUsd } from "@/lib/format";
import {
  AVAILABILITY_CONTENT,
  CONTENT,
  ROUTES,
  UI_TIMINGS,
} from "@/lib/site-config";
import { useStorefront } from "@/lib/StorefrontContext";

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { products, categories, catalogState, config } = useStorefront();
  const { addItem } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);
  const [added, setAdded] = useState(false);
  const product = products.find((item) => item.id === id);
  const related = useMemo(
    () => (product ? relatedProducts(products, product) : []),
    [product, products],
  );

  if (catalogState === "loading")
    return (
      <div className="page-loading" aria-busy="true">
        {CONTENT.common.loading}
      </div>
    );
  if (!product) {
    return (
      <div className="section-shell product-not-found">
        <h1>{CONTENT.product.notFound}</h1>
        <p>{CONTENT.product.notFoundBody}</p>
        <Link className="btn btn-primary" href={ROUTES.products}>
          {CONTENT.common.shopNow}
        </Link>
      </div>
    );
  }

  const category = categories.find((item) => item.id === product.category);
  const availability = AVAILABILITY_CONTENT[product.availability];
  const maximum = Math.min(
    product.inventoryQuantity,
    config?.maxQuantityPerItem ?? product.inventoryQuantity,
  );
  const discount = discountPercent(
    product.priceCents,
    product.compareAtPriceCents,
  );
  const unavailable = product.availability === "out_of_stock";
  const selectedProduct = product;

  function add() {
    addItem(selectedProduct, quantity);
    setAdded(true);
    window.setTimeout(() => setAdded(false), UI_TIMINGS.addToCartFeedbackMs);
  }

  return (
    <div className="product-page section-shell">
      <nav className="breadcrumbs" aria-label={CONTENT.common.breadcrumb}>
        <Link href={ROUTES.home}>{CONTENT.common.home}</Link>
        <span>/</span>
        <Link href={ROUTES.category(product.category)}>{category?.label}</Link>
        <span>/</span>
        <span aria-current="page">{product.name}</span>
      </nav>
      <section className="product-detail">
        <div className="product-gallery">
          <div className="product-main-image">
            <img
              src={product.images[selectedImage]!.src}
              alt={product.images[selectedImage]!.alt}
              width={640}
              height={480}
            />
          </div>
          {product.images.length > 1 && (
            <div className="product-thumbnails">
              {product.images.map((image, index) => (
                <button
                  key={image.src}
                  type="button"
                  className={selectedImage === index ? "active" : undefined}
                  onClick={() => setSelectedImage(index)}
                  aria-label={CONTENT.product.viewImage(index + 1)}
                >
                  <img src={image.src} alt="" width={640} height={480} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="product-information">
          <p className="eyebrow">{category?.label}</p>
          <h1>{product.name}</h1>
          <p className="product-sku">
            {CONTENT.product.sku}: {product.sku}
          </p>
          <div className="product-detail-price">
            <strong>{formatUsd(product.priceCents)}</strong>
            {product.compareAtPriceCents && (
              <del>{formatUsd(product.compareAtPriceCents)}</del>
            )}
            {discount !== null && (
              <Badge variant="danger">{CONTENT.product.save(discount)}</Badge>
            )}
          </div>
          <p className="product-description">{product.description}</p>
          <Badge
            variant={
              availability.tone === "neutral" ? "neutral" : availability.tone
            }
          >
            {availability.label}
          </Badge>
          {product.availability === "low_stock" && (
            <p className="stock-note">
              {CONTENT.product.lowStock(product.inventoryQuantity)}
            </p>
          )}
          <div className="purchase-panel">
            {!unavailable ? (
              <>
                <div>
                  <label>{CONTENT.product.quantity}</label>
                  <QuantityStepper
                    value={quantity}
                    onChange={setQuantity}
                    min={1}
                    max={Math.max(1, maximum)}
                    label={CONTENT.product.quantityFor(product.name)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={add}
                  disabled={added}
                >
                  {added ? (
                    <>
                      <Icon name="check" />
                      {CONTENT.common.added}
                    </>
                  ) : (
                    <>
                      <Icon name="cart" />
                      {CONTENT.common.addToCart}
                    </>
                  )}
                </button>
              </>
            ) : (
              <p className="inline-warning">{CONTENT.product.unavailable}</p>
            )}
          </div>
          <div className="product-promises">
            <div>
              <Icon name="truck" />
              <span>
                <strong>
                  {config?.shippingMethods[0]?.label ??
                    CONTENT.product.deliveryLoading}
                </strong>
                {config?.shippingMethods[0]?.description}
              </span>
            </div>
            <div>
              <Icon name="shield" />
              <span>
                <strong>{CONTENT.product.checkoutTitle}</strong>
                {CONTENT.product.checkoutBody}
              </span>
            </div>
          </div>
        </div>
      </section>
      <section
        className="specification-section"
        aria-labelledby="specification-title"
      >
        <header>
          <p className="eyebrow">{CONTENT.product.specificationsEyebrow}</p>
          <h2 id="specification-title">{CONTENT.product.specifications}</h2>
        </header>
        <dl>
          {product.specifications.map((specification) => (
            <div key={specification.label}>
              <dt>{specification.label}</dt>
              <dd>{specification.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="related-section" aria-labelledby="related-title">
        <h2 id="related-title">{CONTENT.product.related}</h2>
        <ProductGrid products={related} skeletonCount={3} />
      </section>
      {added && (
        <div className="toast" role="status">
          <Icon name="check" />
          {CONTENT.common.added}
        </div>
      )}
    </div>
  );
}

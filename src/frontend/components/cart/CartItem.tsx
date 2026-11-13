"use client";

import Link from "next/link";
import QuantityStepper from "@/components/ui/QuantityStepper";
import Badge from "@/components/ui/Badge";
import { useCart } from "@/lib/CartContext";
import { formatUsd } from "@/lib/format";
import { AVAILABILITY_CONTENT, CONTENT, ROUTES } from "@/lib/site-config";
import { useStorefront } from "@/lib/StorefrontContext";
import type { CartItem as CartItemType } from "@/lib/types";

export default function CartItem({ item }: { item: CartItemType }) {
  const { updateQuantity, removeItem } = useCart();
  const { config } = useStorefront();
  const availability = AVAILABILITY_CONTENT[item.product.availability];
  const maximum = Math.min(
    item.product.inventoryQuantity,
    config?.maxQuantityPerItem ?? item.product.inventoryQuantity,
  );

  return (
    <article className="cart-item">
      <Link href={ROUTES.product(item.product.id)} className="cart-item-image">
        <img
          src={item.product.images[0]!.src}
          alt={item.product.images[0]!.alt}
          width={640}
          height={480}
        />
      </Link>
      <div className="cart-item-info">
        <span className="cart-item-sku">{item.product.sku}</span>
        <h2>
          <Link href={ROUTES.product(item.product.id)}>
            {item.product.name}
          </Link>
        </h2>
        <Badge
          variant={
            availability.tone === "neutral" ? "neutral" : availability.tone
          }
        >
          {availability.label}
        </Badge>
        <span className="cart-item-unit-price">
          {CONTENT.cart.unitPrice(formatUsd(item.product.priceCents))}
        </span>
      </div>
      <div className="cart-item-controls">
        <QuantityStepper
          value={item.quantity}
          onChange={(quantity) => updateQuantity(item.product.id, quantity)}
          min={1}
          max={Math.max(1, maximum)}
          label={CONTENT.product.quantityFor(item.product.name)}
        />
        <strong>{formatUsd(item.product.priceCents * item.quantity)}</strong>
        <button
          type="button"
          className="text-button danger"
          onClick={() => removeItem(item.product.id)}
        >
          {CONTENT.cart.remove}
        </button>
      </div>
    </article>
  );
}

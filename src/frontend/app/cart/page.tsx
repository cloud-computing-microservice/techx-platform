"use client";

import Link from "next/link";
import CartItem from "@/components/cart/CartItem";
import CartSummary from "@/components/cart/CartSummary";
import EmptyState from "@/components/ui/EmptyState";
import Icon from "@/components/ui/Icon";
import { useCart } from "@/lib/CartContext";
import { CONTENT, ROUTES } from "@/lib/site-config";

export default function CartPage() {
  const {
    items,
    itemCount,
    ready,
    reconciliationNotice,
    dismissReconciliationNotice,
  } = useCart();

  if (!ready)
    return (
      <div className="page-loading" aria-busy="true">
        {CONTENT.common.loading}
      </div>
    );

  return (
    <div className="cart-page section-shell">
      <nav className="breadcrumbs" aria-label={CONTENT.common.breadcrumb}>
        <Link href={ROUTES.home}>{CONTENT.common.home}</Link>
        <span>/</span>
        <span aria-current="page">{CONTENT.cart.title}</span>
      </nav>
      <header className="page-heading">
        <p className="eyebrow">{CONTENT.cart.eyebrow}</p>
        <h1>{CONTENT.cart.title}</h1>
        <p>{CONTENT.cart.count(itemCount)}</p>
      </header>
      {reconciliationNotice && (
        <div className="inline-notice" role="status">
          <Icon name="check" />
          <span>{CONTENT.cart.reconciled}</span>
          <button
            className="icon-button"
            type="button"
            onClick={dismissReconciliationNotice}
            aria-label={CONTENT.cart.dismissNotice}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState
          icon="cart"
          title={CONTENT.cart.empty}
          description={CONTENT.cart.emptyBody}
          actionLabel={CONTENT.common.shopNow}
          actionHref={ROUTES.products}
        />
      ) : (
        <div className="cart-layout">
          <div className="cart-items">
            {items.map((item) => (
              <CartItem key={item.product.id} item={item} />
            ))}
            <Link className="text-link" href={ROUTES.products}>
              ← {CONTENT.common.continueShopping}
            </Link>
          </div>
          <CartSummary />
        </div>
      )}
    </div>
  );
}

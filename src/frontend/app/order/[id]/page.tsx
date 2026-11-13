"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import OrderDetails from "@/components/order/OrderDetails";
import Icon from "@/components/ui/Icon";
import { ApiClientError, getOrder } from "@/lib/api-client";
import { findCachedOrder, saveOrderToHistory } from "@/lib/order-history";
import {
  CONTENT,
  ORDER_ERROR_CONTENT,
  ROUTES,
  UI_TIMINGS,
} from "@/lib/site-config";
import type { Order } from "@/lib/types";

type LoadState = "loading" | "success" | "error";

export default function OrderConfirmationPage() {
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setState("loading");
    getOrder(id)
      .then(({ order: loaded }) => {
        if (!active) return;
        saveOrderToHistory(loaded);
        setOrder(loaded);
        setState("success");
      })
      .catch((reason) => {
        if (!active) return;
        const fallback = findCachedOrder(id);
        if (fallback) {
          setOrder(fallback);
          setState("success");
          return;
        }
        const code =
          reason instanceof ApiClientError ? reason.code : "UNEXPECTED_ERROR";
        setError(ORDER_ERROR_CONTENT[code] ?? CONTENT.order.notFound);
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [id]);

  async function copyId() {
    if (!order) return;
    await navigator.clipboard.writeText(order.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), UI_TIMINGS.transientFeedbackMs);
  }

  if (state === "loading")
    return (
      <div className="page-loading" aria-busy="true">
        {CONTENT.common.loading}
      </div>
    );
  if (state === "error" || !order) {
    return (
      <div className="section-shell order-error">
        <h1>{CONTENT.order.unavailable}</h1>
        <p>{error}</p>
        <div>
          <Link className="btn btn-secondary" href={ROUTES.orders}>
            {CONTENT.order.lookupAnother}
          </Link>
          <Link className="btn btn-primary" href={ROUTES.products}>
            {CONTENT.common.shopNow}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="confirmation-page section-shell">
      <header className="confirmation-heading">
        <span>
          <Icon name="check" size={36} />
        </span>
        <p className="eyebrow">{CONTENT.order.checkoutComplete}</p>
        <h1>{CONTENT.order.confirmed}</h1>
        <p>{CONTENT.order.confirmedBody}</p>
      </header>
      <OrderDetails order={order} onCopy={copyId} copied={copied} />
      <div className="confirmation-actions">
        <Link className="btn btn-secondary" href={ROUTES.orders}>
          {CONTENT.order.lookupAnOrder}
        </Link>
        <Link className="btn btn-primary" href={ROUTES.products}>
          {CONTENT.common.continueShopping}
          <Icon name="arrow" size={18} />
        </Link>
      </div>
    </div>
  );
}

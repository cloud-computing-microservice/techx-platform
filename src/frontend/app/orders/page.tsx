"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import OrderDetails from "@/components/order/OrderDetails";
import Icon from "@/components/ui/Icon";
import { ApiClientError, getOrder } from "@/lib/api-client";
import { isOrderId } from "@/lib/checkout";
import { formatDateTime, formatUsd } from "@/lib/format";
import { readOrderHistory, saveOrderToHistory } from "@/lib/order-history";
import {
  CONTENT,
  ORDER_ERROR_CONTENT,
  ORDER_STATUS_CONTENT,
  ROUTES,
  UI_TIMINGS,
} from "@/lib/site-config";
import type { Order } from "@/lib/types";

type LookupState = "idle" | "loading" | "success" | "error";

export default function OrdersPage() {
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<LookupState>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<Order[]>([]);

  useEffect(() => setHistory(readOrderHistory()), []);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    const id = orderId.trim();
    if (!isOrderId(id)) {
      setError(CONTENT.order.invalidId);
      setState("error");
      return;
    }
    setState("loading");
    setError("");
    setOrder(null);
    try {
      const result = await getOrder(id);
      setOrder(result.order);
      setHistory(saveOrderToHistory(result.order));
      setState("success");
    } catch (reason) {
      const code =
        reason instanceof ApiClientError ? reason.code : "UNEXPECTED_ERROR";
      setError(ORDER_ERROR_CONTENT[code] ?? CONTENT.order.notFound);
      setState("error");
    }
  }

  async function copyId() {
    if (!order) return;
    await navigator.clipboard.writeText(order.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), UI_TIMINGS.transientFeedbackMs);
  }

  return (
    <div className="lookup-page section-shell">
      <nav className="breadcrumbs" aria-label={CONTENT.common.breadcrumb}>
        <Link href={ROUTES.home}>{CONTENT.common.home}</Link>
        <span>/</span>
        <span aria-current="page">{CONTENT.shell.orderLookup}</span>
      </nav>
      <div className="lookup-hero">
        <div>
          <p className="eyebrow">{CONTENT.order.eyebrow}</p>
          <h1>{CONTENT.order.lookupTitle}</h1>
          <p>{CONTENT.order.lookupBody}</p>
        </div>
        <Icon name="package" size={48} />
      </div>
      <form className="lookup-form" onSubmit={lookup} noValidate>
        <h2>{CONTENT.order.searchTitle}</h2>
        <label htmlFor="order-id">{CONTENT.order.id}</label>
        <div>
          <input
            id="order-id"
            value={orderId}
            onChange={(event) => {
              setOrderId(event.target.value);
              setError("");
            }}
            placeholder={CONTENT.order.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={state === "error"}
            aria-describedby={
              state === "error" ? "lookup-error" : "lookup-help"
            }
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={state === "loading"}
          >
            {state === "loading" ? (
              CONTENT.order.lookingUp
            ) : (
              <>
                <Icon name="search" size={18} />
                {CONTENT.order.lookupAction}
              </>
            )}
          </button>
        </div>
        <p id="lookup-help">{CONTENT.order.ttlHelp}</p>
        {state === "error" && (
          <p id="lookup-error" className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {state === "success" && order && (
        <OrderDetails order={order} onCopy={copyId} copied={copied} compact />
      )}
      <section className="order-history" aria-labelledby="order-history-title">
        <div className="order-history-heading">
          <div>
            <p className="eyebrow">{CONTENT.shell.orderLookup}</p>
            <h2 id="order-history-title">{CONTENT.order.historyTitle}</h2>
          </div>
          <p>{CONTENT.order.historyBody}</p>
        </div>
        {history.length === 0 ? (
          <div className="order-history-empty">
            <Icon name="package" size={28} />
            <p>{CONTENT.order.historyEmpty}</p>
            <Link className="text-link" href={ROUTES.products}>
              {CONTENT.common.shopNow}
              <Icon name="arrow" size={16} />
            </Link>
          </div>
        ) : (
          <div className="order-history-list">
            {history.map((item) => (
              <article className="order-history-card" key={item.id}>
                <div className="order-history-icon">
                  <Icon name="package" size={20} />
                </div>
                <div className="order-history-main">
                  <span className="badge badge-success">
                    {ORDER_STATUS_CONTENT[item.status].label}
                  </span>
                  <h3>{item.id}</h3>
                  <p>
                    {formatDateTime(item.createdAt)} ·{" "}
                    {CONTENT.order.historyCount(
                      item.items.reduce(
                        (total, line) => total + line.quantity,
                        0,
                      ),
                    )}
                  </p>
                </div>
                <strong>{formatUsd(item.totalCents)}</strong>
                <Link
                  className="btn btn-secondary"
                  href={ROUTES.order(item.id)}
                >
                  {CONTENT.order.viewDetails}
                  <Icon name="arrow" size={16} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

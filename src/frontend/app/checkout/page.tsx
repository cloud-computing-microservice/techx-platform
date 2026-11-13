"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CartSummary from "@/components/cart/CartSummary";
import EmptyState from "@/components/ui/EmptyState";
import Icon from "@/components/ui/Icon";
import { ApiClientError, createOrder } from "@/lib/api-client";
import {
  createOrderInput,
  createIdempotencyKey,
  EMPTY_CHECKOUT_FORM,
  validateCheckout,
  type CheckoutErrors,
  type CheckoutField,
  type CheckoutForm,
} from "@/lib/checkout";
import { hasUnavailableItems } from "@/lib/cart";
import { saveOrderToHistory } from "@/lib/order-history";
import { useCart } from "@/lib/CartContext";
import {
  CHECKOUT_FIELDS,
  CHECKOUT_FIELD_GROUPS,
  CONTENT,
  ORDER_ERROR_CONTENT,
  ROUTES,
  UI_STORAGE_KEYS,
  UI_LIMITS,
} from "@/lib/site-config";
import { useStorefront } from "@/lib/StorefrontContext";

export default function CheckoutPage() {
  const router = useRouter();
  const { items, ready, clearCart } = useCart();
  const { config } = useStorefront();
  const [form, setForm] = useState<CheckoutForm>(EMPTY_CHECKOUT_FORM);
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  if (!ready)
    return (
      <div className="page-loading" aria-busy="true">
        {CONTENT.common.loading}
      </div>
    );
  if (items.length === 0) {
    return (
      <div className="section-shell">
        <EmptyState
          icon="cart"
          title={CONTENT.checkout.emptyTitle}
          description={CONTENT.cart.emptyBody}
          actionLabel={CONTENT.common.shopNow}
          actionHref={ROUTES.products}
        />
      </div>
    );
  }

  function updateField(field: CheckoutField, value: string) {
    const normalized =
      field === "region"
        ? value.slice(0, UI_LIMITS.regionCharacters).toUpperCase()
        : value;
    setForm((current) => ({ ...current, [field]: normalized }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError("");
  }

  function renderField(field: CheckoutField) {
    const definition = CHECKOUT_FIELDS[field];
    const error = errors[field];
    return (
      <div className={`form-field field-${field}`} key={field}>
        <label htmlFor={field}>{definition.label}</label>
        <input
          id={field}
          name={field}
          type={field === "email" ? "email" : "text"}
          autoComplete={definition.autoComplete}
          inputMode={definition.inputMode}
          placeholder={definition.placeholder}
          value={form[field]}
          onChange={(event) => updateField(field, event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${field}-error` : undefined}
          maxLength={
            field === "line2" ? UI_LIMITS.optionalAddressCharacters : undefined
          }
        />
        {error && (
          <span id={`${field}-error`} className="field-error">
            {error}
          </span>
        )}
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !config || hasUnavailableItems(items)) return;
    const nextErrors = validateCheckout(form);
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0] as CheckoutField | undefined;
    if (firstError) {
      document.getElementById(firstError)?.focus();
      return;
    }

    const input = createOrderInput(form, items);
    const fingerprint = JSON.stringify(input);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: createIdempotencyKey() };
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const { order } = await createOrder(input, attempt.current.key);
      window.sessionStorage.setItem(
        UI_STORAGE_KEYS.lastOrder,
        JSON.stringify(order),
      );
      saveOrderToHistory(order);
      clearCart();
      router.push(ROUTES.order(order.id));
    } catch (error) {
      const code =
        error instanceof ApiClientError ? error.code : "UNEXPECTED_ERROR";
      setSubmitError(
        ORDER_ERROR_CONTENT[code] ??
          (error instanceof Error
            ? error.message
            : CONTENT.checkout.fallbackError),
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-page section-shell">
      <nav className="breadcrumbs" aria-label={CONTENT.common.breadcrumb}>
        <Link href={ROUTES.home}>{CONTENT.common.home}</Link>
        <span>/</span>
        <Link href={ROUTES.cart}>{CONTENT.cart.title}</Link>
        <span>/</span>
        <span aria-current="page">{CONTENT.checkout.title}</span>
      </nav>
      <header className="page-heading">
        <p className="eyebrow">{CONTENT.checkout.eyebrow}</p>
        <h1>{CONTENT.checkout.title}</h1>
        <p>{CONTENT.checkout.intro}</p>
      </header>
      <div className="checkout-layout">
        <form className="checkout-form" onSubmit={submit} noValidate>
          <section aria-labelledby="contact-heading">
            <div className="form-section-heading">
              <span>1</span>
              <h2 id="contact-heading">{CONTENT.checkout.contact}</h2>
            </div>
            <div className="form-grid">
              {CHECKOUT_FIELD_GROUPS.contact.map(renderField)}
            </div>
          </section>
          <section aria-labelledby="shipping-heading">
            <div className="form-section-heading">
              <span>2</span>
              <h2 id="shipping-heading">{CONTENT.checkout.shipping}</h2>
            </div>
            <div className="form-grid address-grid">
              {CHECKOUT_FIELD_GROUPS.address.map(renderField)}
              <div className="form-field country-field">
                <label>{CONTENT.checkout.country}</label>
                <input value={CONTENT.checkout.countryValue} disabled />
              </div>
            </div>
          </section>
          <section
            className="checkout-assurance"
            aria-labelledby="payment-heading"
          >
            <Icon name="shield" size={26} />
            <div>
              <h2 id="payment-heading">{CONTENT.checkout.assuranceTitle}</h2>
              <p>{CONTENT.checkout.assuranceBody}</p>
            </div>
          </section>
          {submitError && (
            <div className="inline-error" role="alert">
              <h2>{CONTENT.checkout.submitErrorTitle}</h2>
              <p>
                {submitError} {CONTENT.checkout.submitErrorSuffix}
              </p>
            </div>
          )}
          <div className="checkout-actions">
            <Link className="btn btn-secondary" href={ROUTES.cart}>
              ← {CONTENT.checkout.back}
            </Link>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={submitting || !config || hasUnavailableItems(items)}
            >
              {submitting ? (
                CONTENT.checkout.submitting
              ) : (
                <>
                  <Icon name="shield" size={18} />
                  {CONTENT.checkout.placeOrder}
                </>
              )}
            </button>
          </div>
        </form>
        <CartSummary mode="checkout" />
      </div>
    </div>
  );
}

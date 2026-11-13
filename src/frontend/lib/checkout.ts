import type { CartItem, CreateOrderInput } from "./types";
import { CONTENT, UI_LIMITS } from "./site-config";

export interface CheckoutForm {
  email: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
}

export type CheckoutField = keyof CheckoutForm;
export type CheckoutErrors = Partial<Record<CheckoutField, string>>;

export const EMPTY_CHECKOUT_FORM: CheckoutForm = {
  email: "",
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
};

type CheckoutCrypto = Pick<Crypto, "getRandomValues"> &
  Partial<Pick<Crypto, "randomUUID">>;

export function createIdempotencyKey(
  cryptoApi: CheckoutCrypto | undefined = globalThis.crypto,
): string {
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const values = new Uint32Array(4);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  const randomPart = Array.from(values, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
  return `checkout-${Date.now().toString(36)}-${randomPart}`;
}

export function validateCheckout(form: CheckoutForm): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const name = form.name.trim();
  const email = form.email.trim();
  if (
    name.length < UI_LIMITS.customerNameMinimum ||
    name.length > UI_LIMITS.customerNameMaximum
  )
    errors.name = CONTENT.checkout.validation.name;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = CONTENT.checkout.validation.email;
  if (form.line1.trim().length < UI_LIMITS.streetAddressMinimum)
    errors.line1 = CONTENT.checkout.validation.line1;
  if (form.line2.trim().length > UI_LIMITS.optionalAddressCharacters)
    errors.line2 = CONTENT.checkout.validation.line2;
  if (form.city.trim().length < UI_LIMITS.cityMinimum)
    errors.city = CONTENT.checkout.validation.city;
  if (!/^[A-Za-z]{2}$/.test(form.region.trim()))
    errors.region = CONTENT.checkout.validation.region;
  if (!/^\d{5}(?:-\d{4})?$/.test(form.postalCode.trim()))
    errors.postalCode = CONTENT.checkout.validation.postalCode;
  return errors;
}

export function createOrderInput(
  form: CheckoutForm,
  items: CartItem[],
): CreateOrderInput {
  const line2 = form.line2.trim();
  return {
    items: items.map((item) => ({
      productId: item.product.id,
      quantity: item.quantity,
    })),
    customer: {
      name: form.name.trim().replace(/\s+/g, " "),
      email: form.email.trim().toLowerCase(),
    },
    shippingAddress: {
      line1: form.line1.trim().replace(/\s+/g, " "),
      ...(line2 ? { line2: line2.replace(/\s+/g, " ") } : {}),
      city: form.city.trim().replace(/\s+/g, " "),
      region: form.region.trim().toUpperCase(),
      postalCode: form.postalCode.trim(),
      countryCode: "US",
    },
    shippingMethod: "standard",
  };
}

export function isOrderId(value: string): boolean {
  return /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

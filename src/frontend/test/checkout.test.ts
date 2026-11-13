import { describe, expect, it } from "vitest";
import {
  createOrderInput,
  createIdempotencyKey,
  EMPTY_CHECKOUT_FORM,
  isOrderId,
  validateCheckout,
} from "@/lib/checkout";
import { productFixture } from "./fixtures";

describe("checkout contract", () => {
  const validForm = {
    ...EMPTY_CHECKOUT_FORM,
    email: " Test@Example.com ",
    name: " Test   Customer ",
    line1: " 100   Test Street ",
    city: " Seattle ",
    region: "wa",
    postalCode: "98101",
  };

  it("validates user-visible fields and focuses on meaningful errors", () => {
    const errors = validateCheckout(EMPTY_CHECKOUT_FORM);
    expect(Object.keys(errors)).toEqual([
      "name",
      "email",
      "line1",
      "city",
      "region",
      "postalCode",
    ]);
    expect(validateCheckout(validForm)).toEqual({});
  });

  it("normalizes a payment-free order payload", () => {
    const input = createOrderInput(validForm, [
      { product: productFixture, quantity: 2 },
    ]);
    expect(input.customer).toEqual({
      name: "Test Customer",
      email: "test@example.com",
    });
    expect(input.shippingAddress).toEqual({
      line1: "100 Test Street",
      city: "Seattle",
      region: "WA",
      postalCode: "98101",
      countryCode: "US",
    });
    expect(JSON.stringify(input)).not.toMatch(/card|cvv|payment/i);
  });

  it("validates complete order ids before lookup", () => {
    expect(isOrderId("ord_00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isOrderId("ord_partial")).toBe(false);
  });

  it("creates an idempotency key when randomUUID is unavailable on HTTP", () => {
    const cryptoWithoutRandomUuid = {
      getRandomValues: <T extends ArrayBufferView | null>(values: T): T => {
        if (values instanceof Uint32Array) values.fill(0x1234abcd);
        return values;
      },
    } as Pick<Crypto, "getRandomValues">;

    expect(createIdempotencyKey(cryptoWithoutRandomUuid)).toMatch(
      /^checkout-[a-z0-9]+-(1234abcd){4}$/,
    );
  });
});

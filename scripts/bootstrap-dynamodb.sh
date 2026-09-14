#!/bin/sh
set -eu

endpoint="http://dynamodb-local:8000"

if ! aws dynamodb describe-table \
  --endpoint-url "$endpoint" \
  --table-name "$ORDER_TABLE_NAME" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --endpoint-url "$endpoint" \
    --table-name "$ORDER_TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null

  aws dynamodb wait table-exists \
    --endpoint-url "$endpoint" \
    --table-name "$ORDER_TABLE_NAME"
fi

ttl_status="$(aws dynamodb describe-time-to-live \
  --endpoint-url "$endpoint" \
  --table-name "$ORDER_TABLE_NAME" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' \
  --output text)"
ttl_attribute="$(aws dynamodb describe-time-to-live \
  --endpoint-url "$endpoint" \
  --table-name "$ORDER_TABLE_NAME" \
  --query 'TimeToLiveDescription.AttributeName' \
  --output text)"

case "$ttl_status:$ttl_attribute" in
  ENABLED:ttlEpochSeconds|ENABLING:ttlEpochSeconds)
    ;;
  DISABLED:*|None:*)
    aws dynamodb update-time-to-live \
      --endpoint-url "$endpoint" \
      --table-name "$ORDER_TABLE_NAME" \
      --time-to-live-specification Enabled=true,AttributeName=ttlEpochSeconds >/dev/null
    ;;
  *)
    printf >&2 'Unexpected DynamoDB TTL configuration: status=%s attribute=%s\n' \
      "$ttl_status" "$ttl_attribute"
    exit 1
    ;;
esac

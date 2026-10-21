#!/bin/sh
# Idempotent: create-queue with identical attributes returns the existing queue.
set -eu

MAX_RECEIVE=5 # phase 7 asserts the app config equals this

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true"}' >/dev/null

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$DLQ_ARN" "$MAX_RECEIVE")
ATTRS=$(printf '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":%s}' "$(printf '%s' "$REDRIVE" | sed 's/"/\\"/g; s/^/"/; s/$/"/')")
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "$ATTRS" >/dev/null

awslocal sqs create-queue --queue-name wager-events >/dev/null

awslocal sqs list-queues

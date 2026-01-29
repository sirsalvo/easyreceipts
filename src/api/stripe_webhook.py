# src/api/stripe_webhook.py
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

import boto3
import stripe

from ssm_cache import get_param, get_env_param_name

dynamodb = boto3.resource("dynamodb")


def _users_table():
    name = os.getenv("USERS_TABLE", "")
    if not name:
        raise RuntimeError("USERS_TABLE env var missing")
    return dynamodb.Table(name)


def _stripe_init():
    secret_name = get_env_param_name("STRIPE_SECRET_KEY_PARAM")
    stripe.api_key = get_param(secret_name, decrypt=True)


def _webhook_secret() -> str:
    wh_name = get_env_param_name("STRIPE_WEBHOOK_SECRET_PARAM")
    return get_param(wh_name, decrypt=True)


def _update_user(
    user_id: str,
    *,
    customer_id: Optional[str] = None,
    subscription_id: Optional[str] = None,
    status: Optional[str] = None,
):
    """
    Update user billing fields. Idempotent: setting same values repeatedly is safe.
    """
    now = int(time.time())
    expr_parts = ["updatedAt=:u"]
    vals: Dict[str, Any] = {":u": now}
    names: Dict[str, str] = {}

    def set_attr(attr: str, placeholder: str, value: Any):
        if value is None or value == "":
            return
        names[f"#{attr}"] = attr
        vals[placeholder] = value
        expr_parts.append(f"#{attr}={placeholder}")

    set_attr("stripeCustomerId", ":c", customer_id)
    set_attr("stripeSubscriptionId", ":s", subscription_id)
    set_attr("status", ":st", status)

    _users_table().update_item(
        Key={"userId": user_id},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=names if names else None,
        ExpressionAttributeValues=vals,
    )


def handle_stripe_webhook(event: Dict[str, Any], origin: str, json_fn) -> Dict[str, Any]:
    """
    POST /webhooks/stripe (PUBLIC)
    Verifies signature and applies subscription status changes.
    """
    # NOTE: construct_event does not require api_key, but we keep init here because we
    # retrieve subscription in some flows.
    _stripe_init()

    sig = None
    headers = event.get("headers") or {}
    for k in ("stripe-signature", "Stripe-Signature"):
        if k in headers:
            sig = headers[k]
            break

    if not sig:
        return json_fn(400, {"error": "BAD_REQUEST", "message": "Missing Stripe-Signature header."}, origin)

    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8", errors="replace")

    try:
        evt = stripe.Webhook.construct_event(
            payload=body,
            sig_header=sig,
            secret=_webhook_secret(),
        )
    except Exception as e:
        print("Stripe webhook signature verification failed:", repr(e))
        return json_fn(400, {"error": "BAD_SIGNATURE", "message": "Invalid webhook signature."}, origin)

    event_type = evt.get("type")
    data_obj = (evt.get("data") or {}).get("object") or {}

    print(f"Stripe webhook received: type={event_type}")

    def user_id_from_metadata(obj: Dict[str, Any]) -> Optional[str]:
        md = obj.get("metadata") or {}
        return md.get("userId")

    # 1) Checkout completed: we DO have client_reference_id -> userId.
    # Make this the primary activation point to avoid missing metadata on invoice/subscription.
    if event_type == "checkout.session.completed":
        user_id = data_obj.get("client_reference_id") or user_id_from_metadata(data_obj)
        customer_id = data_obj.get("customer")
        subscription_id = data_obj.get("subscription")
        payment_status = (data_obj.get("payment_status") or "").lower()

        if not user_id:
            print("checkout.session.completed ignored: missing user_id")
            return json_fn(200, {"received": True}, origin)

        # For subscription checkouts, session completion is a strong signal.
        # If payment_status is present and not paid, we keep status unchanged.
        set_active = True
        if payment_status and payment_status != "paid":
            set_active = False

        if set_active:
            _update_user(
                user_id,
                customer_id=customer_id,
                subscription_id=subscription_id,
                status="active",
            )
            print(f"User activated via checkout.session.completed: userId={user_id}")
        else:
            # Still store linkage to customer/subscription so later events can correlate.
            _update_user(user_id, customer_id=customer_id, subscription_id=subscription_id)
            print(f"Checkout completed but not paid yet: userId={user_id}, payment_status={payment_status}")

        return json_fn(200, {"received": True}, origin)

    # 2) Invoice payment succeeded: set active (best-effort userId discovery)
    if event_type == "invoice.payment_succeeded":
        subscription_id = data_obj.get("subscription")
        customer_id = data_obj.get("customer")

        user_id = user_id_from_metadata(data_obj)

        # Best-effort: retrieve subscription to get metadata.userId
        if not user_id and subscription_id:
            try:
                sub = stripe.Subscription.retrieve(subscription_id)
                user_id = (sub.get("metadata") or {}).get("userId")
            except Exception as e:
                print("Failed to retrieve subscription for metadata lookup:", repr(e))
                user_id = None

        if user_id:
            _update_user(user_id, customer_id=customer_id, subscription_id=subscription_id, status="active")
            print(f"User activated via invoice.payment_succeeded: userId={user_id}")
        else:
            print(
                "invoice.payment_succeeded received but could not resolve userId "
                f"(subscription_id={subscription_id}, customer_id={customer_id})"
            )

        return json_fn(200, {"received": True}, origin)

    # 3) Subscription deleted: set expired (requires userId in metadata; if not present we log)
    if event_type == "customer.subscription.deleted":
        subscription_id = data_obj.get("id")
        customer_id = data_obj.get("customer")
        user_id = user_id_from_metadata(data_obj)

        if user_id:
            _update_user(user_id, customer_id=customer_id, subscription_id=subscription_id, status="expired")
            print(f"User expired via customer.subscription.deleted: userId={user_id}")
        else:
            print(f"customer.subscription.deleted received but missing metadata.userId (subscription_id={subscription_id})")

        return json_fn(200, {"received": True}, origin)

    # Ignore other events (but always 200 so Stripe doesn't retry forever)
    return json_fn(200, {"received": True}, origin)

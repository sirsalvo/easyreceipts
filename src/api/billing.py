# src/api/billing.py
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError
import stripe

dynamodb = boto3.resource("dynamodb")


def _users_table():
    name = os.getenv("USERS_TABLE", "")
    if not name:
        raise RuntimeError("USERS_TABLE env var missing")
    return dynamodb.Table(name)


from ssm_cache import get_param, get_env_param_name

def _stripe_init():
    secret_name = get_env_param_name("STRIPE_SECRET_KEY_PARAM")
    stripe.api_key = get_param(secret_name, decrypt=True)

def _stripe_price_id() -> str:
    price_name = get_env_param_name("STRIPE_PRICE_ID_PARAM")
    return get_param(price_name, decrypt=False)

def _app_base_url() -> str:
    # Use CloudFront base URL (recommended) e.g. https://xxxx.cloudfront.net
    return os.getenv("APP_BASE_URL", "").rstrip("/")


def _get_claims(event: Dict[str, Any]) -> Dict[str, Any]:
    return (
        (event.get("requestContext") or {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    ) or {}


def _user_id_email(event: Dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    c = _get_claims(event)
    return c.get("sub"), c.get("email")


def _get_user(user_id: str) -> Optional[Dict[str, Any]]:
    try:
        return _users_table().get_item(Key={"userId": user_id}).get("Item")
    except ClientError:
        return None


def _update_user_billing(user_id: str, *, customer_id: Optional[str], subscription_id: Optional[str], status: Optional[str]):
    expr_parts = ["updatedAt=:u"]
    vals: Dict[str, Any] = {":u": int(__import__("time").time())}
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


def create_checkout_session(event: Dict[str, Any], json_fn, origin: str) -> Dict[str, Any]:
    """
    POST /billing/checkout
    Returns { url } to redirect user to Stripe Checkout.
    """
    user_id, email = _user_id_email(event)
    if not user_id:
        return json_fn(401, {"error": "UNAUTHORIZED", "message": "Authentication required."}, origin)

    price_id = _stripe_price_id()

    if not price_id:
        return json_fn(500, {"error": "SERVER_MISCONFIGURED", "message": "Billing is not configured."}, origin)

    base = _app_base_url()
    if not base:
        return json_fn(500, {"error": "SERVER_MISCONFIGURED", "message": "App base URL is not configured."}, origin)

    _stripe_init()

    user = _get_user(user_id) or {}
    existing_customer = (user.get("stripeCustomerId") or "").strip()

    success_url = f"{base}/settings?billing=success"
    cancel_url = f"{base}/settings?billing=cancel"

    params: Dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        # Helps you map session back to the user
        "client_reference_id": user_id,
        "metadata": {"userId": user_id},
        # Ask for email if missing, otherwise keep it consistent
        "customer_email": email if email else None,
        # Optional: allow promo codes if you want
        # "allow_promotion_codes": True,
    }

    if existing_customer:
        params["customer"] = existing_customer
        params.pop("customer_email", None)

    try:
        session = stripe.checkout.Session.create(**{k: v for k, v in params.items() if v is not None})
        return json_fn(200, {"url": session["url"]}, origin)
    except Exception:
        print("Stripe checkout error:", repr(e))
        return json_fn(500, {"error": "CHECKOUT_FAILED", "message": "Unable to start checkout. Please try again."}, origin)


def create_portal_session(event: Dict[str, Any], json_fn, origin: str) -> Dict[str, Any]:
    """
    POST /billing/portal
    Returns { url } for Stripe Customer Portal.
    """
    user_id, _ = _user_id_email(event)
    if not user_id:
        return json_fn(401, {"error": "UNAUTHORIZED", "message": "Authentication required."}, origin)

    base = _app_base_url()
    if not base:
        return json_fn(500, {"error": "SERVER_MISCONFIGURED", "message": "App base URL is not configured."}, origin)

    user = _get_user(user_id) or {}
    customer_id = (user.get("stripeCustomerId") or "").strip()
    if not customer_id:
        return json_fn(400, {"error": "NO_CUSTOMER", "message": "No billing account found for this user."}, origin)

    _stripe_init()

    try:
        portal = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{base}/settings",
        )
        return json_fn(200, {"url": portal["url"]}, origin)
    except Exception:
        return json_fn(500, {"error": "PORTAL_FAILED", "message": "Unable to open billing portal. Please try again."}, origin)

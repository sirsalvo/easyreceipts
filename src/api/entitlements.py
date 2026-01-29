# src/api/entitlements.py
import os
import time
import math
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

STATUS_TRIAL = "trial"
STATUS_ACTIVE = "active"
STATUS_EXPIRED = "expired"

TRIAL_EXPIRED_RESPONSE = {
    "error": "TRIAL_EXPIRED",
    "message": "Your free trial has ended. Please activate a subscription to continue."
}

UNAUTHORIZED_RESPONSE = {
    "error": "UNAUTHORIZED",
    "message": "Authentication required."
}


def _now() -> int:
    return int(time.time())


def _trial_days() -> int:
    try:
        return int(os.getenv("TRIAL_DAYS", "14"))
    except Exception:
        return 14


def _users_table():
    name = os.getenv("USERS_TABLE")
    if not name:
        raise RuntimeError("USERS_TABLE env var missing")
    return dynamodb.Table(name)


def _claims(event: Dict[str, Any]) -> Dict[str, Any]:
    return (
        (event.get("requestContext") or {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    ) or {}


def _user_id_and_email(event: Dict[str, Any]):
    c = _claims(event)
    return c.get("sub"), c.get("email")


def get_or_create_user(user_id: str, email: Optional[str]) -> Dict[str, Any]:
    table = _users_table()
    now = _now()

    resp = table.get_item(Key={"userId": user_id})
    item = resp.get("Item")

    if not item:
        item = {
            "userId": user_id,
            "email": email or "",
            "createdAt": now,
            "updatedAt": now,
            "trialStartedAt": now,
            "status": STATUS_TRIAL,
        }
        try:
            table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(userId)",
            )
        except ClientError:
            item = table.get_item(Key={"userId": user_id}).get("Item")

    status = item.get("status", STATUS_TRIAL)
    trial_started = int(item.get("trialStartedAt", item["createdAt"]))

    trial_end = trial_started + _trial_days() * 86400
    now = _now()

    expired = now >= trial_end
    days_remaining = max(0, math.ceil((trial_end - now) / 86400))

    if status != STATUS_ACTIVE and expired and status != STATUS_EXPIRED:
        table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET #s=:s, updatedAt=:u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": STATUS_EXPIRED, ":u": now},
        )
        status = STATUS_EXPIRED
        item["status"] = STATUS_EXPIRED

    item["_computed"] = {
        "trialEndsAt": trial_end,
        "daysRemaining": days_remaining,
        "expired": status == STATUS_EXPIRED,
    }
    return item


def is_premium_endpoint(method: str, path: str) -> bool:
    if path == "/me":
        return False

    if path.startswith("/exports/"):
        return True

    return False


def entitlement_guard(event: Dict[str, Any], origin: str, json_fn):
    method = (
        (event.get("requestContext") or {})
        .get("http", {})
        .get("method", "")
    )
    path = event.get("rawPath") or "/"

    if not is_premium_endpoint(method, path):
        return None

    user_id, email = _user_id_and_email(event)
    if not user_id:
        return json_fn(401, UNAUTHORIZED_RESPONSE, origin)

    user = get_or_create_user(user_id, email)
    status = user.get("status")

    if status == STATUS_ACTIVE:
        return None

    if status == STATUS_TRIAL and not user["_computed"]["expired"]:
        return None

    return json_fn(403, TRIAL_EXPIRED_RESPONSE, origin)

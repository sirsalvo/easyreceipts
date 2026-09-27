# src/api/entitlements.py
import datetime as dt
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

# `trial`/`expired` no longer block anything: every non-active user gets the
# monthly free-tier quota (see consume_quota) instead of a hard cutoff after
# TRIAL_DAYS. The statuses and trialStartedAt are kept as-is (existing users
# need no migration); STATUS_EXPIRED is now informational only.

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


def _free_tier_limit() -> int:
    try:
        return int(os.getenv("FREE_TIER_MONTHLY_LIMIT", "5"))
    except Exception:
        return 5


def _current_period(now: Optional[int] = None) -> str:
    """Calendar month in UTC, e.g. "2026-09". The quota resets when this changes."""
    ts = now if now is not None else _now()
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m")


def _period_ends_at(period: str) -> str:
    """ISO timestamp of the next reset (UTC midnight on the 1st of next month)."""
    year, month = (int(x) for x in period.split("-"))
    year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return dt.datetime(year, month, 1, tzinfo=dt.timezone.utc).isoformat()


def _users_table():
    name = os.getenv("USERS_TABLE")
    if not name:
        raise RuntimeError("USERS_TABLE env var missing")
    return dynamodb.Table(name)


def _usage_table():
    name = os.getenv("USAGE_TABLE")
    if not name:
        raise RuntimeError("USAGE_TABLE env var missing")
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


def get_usage(user_id: str) -> Dict[str, Any]:
    """Current month's usage, without consuming any of it. For display (GET /me)."""
    limit = _free_tier_limit()
    period = _current_period()
    resp = _usage_table().get_item(Key={"PK": f"USER#{user_id}", "SK": f"USAGE#{period}"})
    used = int((resp.get("Item") or {}).get("count", 0))
    return {
        "limit": limit,
        "used": used,
        "remaining": max(0, limit - used),
        "period": period,
        "resetsAt": _period_ends_at(period),
    }


def consume_quota(user_id: str) -> Dict[str, Any]:
    """
    Atomically increments this month's usage counter, but only if it is still
    under the limit: the condition and the increment happen in one DynamoDB
    operation, so two concurrent requests cannot both slip through (each one
    is a separate atomic attempt; DynamoDB serializes them).

    Returns get_usage()'s shape plus "allowed": whether this call was counted.
    """
    limit = _free_tier_limit()
    period = _current_period()
    key = {"PK": f"USER#{user_id}", "SK": f"USAGE#{period}"}

    try:
        resp = _usage_table().update_item(
            Key=key,
            UpdateExpression="SET #c = if_not_exists(#c, :zero) + :one, updatedAt = :u",
            ConditionExpression="attribute_not_exists(#c) OR #c < :limit",
            ExpressionAttributeNames={"#c": "count"},
            ExpressionAttributeValues={":zero": 0, ":one": 1, ":limit": limit, ":u": _now()},
            ReturnValues="UPDATED_NEW",
        )
        used = int(resp["Attributes"]["count"])
        allowed = True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        used = limit
        allowed = False

    return {
        "allowed": allowed,
        "limit": limit,
        "used": used,
        "remaining": max(0, limit - used),
        "period": period,
        "resetsAt": _period_ends_at(period),
    }


def is_metered_endpoint(method: str, path: str) -> bool:
    # Where the free-tier quota is enforced: receipt creation, i.e. the point
    # that hands out a presigned upload URL. Blocking here means a request
    # over quota never reaches Textract, so it never costs anything.
    return method == "POST" and path == "/receipts"


def entitlement_guard(event: Dict[str, Any], origin: str, json_fn):
    method = (
        (event.get("requestContext") or {})
        .get("http", {})
        .get("method", "")
    )
    path = event.get("rawPath") or "/"

    if not is_metered_endpoint(method, path):
        return None

    user_id, email = _user_id_and_email(event)
    if not user_id:
        return json_fn(401, UNAUTHORIZED_RESPONSE, origin)

    user = get_or_create_user(user_id, email)
    if user.get("status") == STATUS_ACTIVE:
        return None

    usage = consume_quota(user_id)
    if usage["allowed"]:
        return None

    # Not 401/403: the frontend treats those as an expired app session and
    # logs the user out, which is wrong for "you've used your free receipts".
    return json_fn(
        402,
        {
            "error": "QUOTA_EXCEEDED",
            "message": (
                f"You've used all {usage['limit']} free receipts this month. "
                "Upgrade to keep scanning, or wait for your quota to reset."
            ),
            "limit": usage["limit"],
            "used": usage["used"],
            "resetsAt": usage["resetsAt"],
        },
        origin,
    )

# src/api/categories.py
from __future__ import annotations

import datetime as dt
import os
import re
import uuid
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key


dynamodb = boto3.resource("dynamodb")


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _table():
    name = os.getenv("CATEGORIES_TABLE", "").strip()
    if not name:
        raise RuntimeError("CATEGORIES_TABLE env var missing")
    return dynamodb.Table(name)


_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _validate_name(name: Any) -> str:
    if not isinstance(name, str):
        raise ValueError("name must be a string")
    v = name.strip()
    if not v:
        raise ValueError("name is required")
    if len(v) > 40:
        raise ValueError("name too long (max 40)")
    return v


def _validate_color(color: Any) -> Optional[str]:
    if color is None:
        return None
    if not isinstance(color, str):
        raise ValueError("color must be a string like #RRGGBB")
    v = color.strip()
    if v == "":
        return None
    if not _COLOR_RE.match(v):
        raise ValueError("color must be in format #RRGGBB")
    return v


def list_categories(user_id: str) -> List[Dict[str, Any]]:
    resp = _table().query(
        KeyConditionExpression=Key("userId").eq(user_id),
    )
    items = resp.get("Items", []) or []
    out: List[Dict[str, Any]] = []
    for it in items:
        out.append(
            {
                "id": it.get("categoryId"),
                "categoryId": it.get("categoryId"),
                "name": it.get("name"),
                "color": it.get("color"),
                "createdAt": it.get("createdAt"),
                "updatedAt": it.get("updatedAt"),
            }
        )
    # stable order: by name
    out.sort(key=lambda x: (x.get("name") or "").lower())
    return out


def create_category(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    name = _validate_name(payload.get("name"))
    color = _validate_color(payload.get("color"))
    now = _now_iso()
    category_id = str(uuid.uuid4())
    item = {
        "userId": user_id,
        "categoryId": category_id,
        "name": name,
        "color": color,
        "createdAt": now,
        "updatedAt": now,
    }
    _table().put_item(Item=item)
    return {
        "id": category_id,
        "categoryId": category_id,
        "name": name,
        "color": color,
        "createdAt": now,
        "updatedAt": now,
    }


def update_category(user_id: str, category_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(category_id, str) or not category_id.strip():
        raise ValueError("invalid categoryId")
    name = payload.get("name", None)
    color = payload.get("color", None)

    expr_parts = ["updatedAt=:u"]
    vals: Dict[str, Any] = {":u": _now_iso()}
    names: Dict[str, str] = {}

    if "name" in payload:
        v = _validate_name(name)
        names["#n"] = "name"
        vals[":n"] = v
        expr_parts.append("#n=:n")

    if "color" in payload:
        v = _validate_color(color)
        names["#c"] = "color"
        vals[":c"] = v
        expr_parts.append("#c=:c")

    resp = _table().update_item(
        Key={"userId": user_id, "categoryId": category_id},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=names if names else None,
        ExpressionAttributeValues=vals,
        ConditionExpression="attribute_exists(userId) AND attribute_exists(categoryId)",
        ReturnValues="ALL_NEW",
    )
    it = resp.get("Attributes") or {}
    return {
        "id": it.get("categoryId"),
        "categoryId": it.get("categoryId"),
        "name": it.get("name"),
        "color": it.get("color"),
        "createdAt": it.get("createdAt"),
        "updatedAt": it.get("updatedAt"),
    }


def delete_category(user_id: str, category_id: str) -> None:
    if not isinstance(category_id, str) or not category_id.strip():
        raise ValueError("invalid categoryId")

    _table().delete_item(
        Key={"userId": user_id, "categoryId": category_id},
        ConditionExpression="attribute_exists(userId) AND attribute_exists(categoryId)",
    )


"""
EasyReceipts - API Lambda entrypoint (HTTP API / Lambda proxy)

Endpoints:
- POST /auth/exchange          (PUBLIC)  OAuth2 code+PKCE -> Cognito tokens
- POST /receipts               (AUTH)    Create receipt + presigned S3 PUT URL
- GET  /receipts               (AUTH)    List receipts for current user (basic)
- GET  /receipts/{receiptId}   (AUTH)    Get receipt status + OCR summary (reads from S3 ocr/<sub>/<id>.json)

S3 layout:
- original/<sub>/<receiptId>           (PUT via presigned URL)
- processed/<sub>/<receiptId>.jpg      (produced by preprocess)
- ocr/<sub>/<receiptId>.json           (produced by OCR lambda; Textract AnalyzeExpense output)

Notes:
- For now, "status" is inferred by existence of S3 artifacts.
- Later we can formalize statuses in DynamoDB and have preprocess/ocr update them.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import time
import os
import re
import uuid
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from decimal import Decimal

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            # Converti in int se è un numero intero, altrimenti in float
            if obj % 1 == 0:
                return int(obj)
            return float(obj)
        return super().default(obj)


dynamodb = boto3.resource("dynamodb")
s3 = boto3.client("s3")

def _load_json_s3(bucket: str, key: str) -> Optional[Dict[str, Any]]:
    """Load and parse a JSON object from S3. Returns None if missing or unreadable."""
    try:
        res = s3.get_object(Bucket=bucket, Key=key)
        raw = res["Body"].read().decode("utf-8")
        return json.loads(raw)
    except Exception:
        return None


RECEIPTS_TABLE = os.getenv("RECEIPTS_TABLE", "")
UPLOADS_BUCKET = os.getenv("UPLOADS_BUCKET", "")

# Categories (user-customizable list)
USER_CATEGORIES_TABLE = os.getenv("USER_CATEGORIES_TABLE", "")
DEFAULT_CATEGORIES = [
    "Groceries",
    "Restaurants",
    "Transport",
    "Shopping",
    "Health",
    "Bills",
    "Entertainment",
    "Travel",
    "Other",
]

COGNITO_DOMAIN = os.getenv("COGNITO_DOMAIN", "").strip()  # without https://
COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID", "").strip()

UI_ORIGIN = os.getenv("UI_ORIGIN", "").strip()  # optional: force allow-origin

DEFAULT_HEADERS = {"content-type": "application/json"}

def _get_me(event: Dict[str, Any], origin: str) -> Dict[str, Any]:
    from entitlements import get_or_create_user

    claims = _claims(event)
    sub = claims.get("sub")
    email = claims.get("email")

    if not sub:
        return _json(401, {"error": "UNAUTHORIZED", "message": "Authentication required."}, origin)

    user = get_or_create_user(sub, email)
    c = user["_computed"]

    return _json(
        200,
        {
            "userId": sub,
            "status": user["status"],
            "trialStartedAt": user.get("trialStartedAt"),
            "trialEndsAt": c["trialEndsAt"],
            "daysRemaining": c["daysRemaining"],
        },
        origin,
    )


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

def _cors(origin: str) -> Dict[str, str]:
    """Return CORS headers for the given origin."""
    allowed = os.environ.get("CORS_ORIGINS", "")
    allowed_list = [o.strip() for o in allowed.split(",") if o.strip()]

    # If no allowed origins configured, do not allow CORS.
    if not allowed_list:
        return {
            "Access-Control-Allow-Origin": "",
            "Access-Control-Allow-Headers": "",
            "Access-Control-Allow-Methods": "",
            "Content-Type": "application/json",
        }

    # Allow only if the request origin matches one of the allowed origins.
    if origin and origin in allowed_list:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
            "Content-Type": "application/json",
        }

    return {
        "Access-Control-Allow-Origin": "",
        "Access-Control-Allow-Headers": "",
        "Access-Control-Allow-Methods": "",
        "Content-Type": "application/json",
    }


# PRIMA (originale)
#def _json(status: int, body: Any, origin: str) -> Dict[str, Any]:
#   headers = _cors(origin)
#    return {"statusCode": status, "headers": headers, "body": json.dumps(body)}

# DOPO (con DecimalEncoder)
def _json(status: int, body: Any, origin: str) -> Dict[str, Any]:
    headers = _cors(origin)
    return {"statusCode": status, "headers": headers, "body": json.dumps(body, cls=DecimalEncoder)}


def _parse_json_body(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Parse JSON body from API Gateway v2 event (supports base64)."""
    body = event.get("body")
    if body is None:
        return None
    try:
        if event.get("isBase64Encoded"):
            import base64
            body = base64.b64decode(body).decode("utf-8")
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8")
        if isinstance(body, str):
            body = body.strip()
            if not body:
                return None
            return json.loads(body)
        # already parsed?
        if isinstance(body, dict):
            return body
        return None
    except Exception:
        return None


def _pick_allow_origin(event: Dict[str, Any]) -> str:
    if UI_ORIGIN:
        return UI_ORIGIN
    h = event.get("headers") or {}
    return h.get("origin") or h.get("Origin") or ""


def _path(event: Dict[str, Any]) -> str:
    return event.get("rawPath") or event.get("path") or "/"


def _method(event: Dict[str, Any]) -> str:
    ctx = event.get("requestContext") or {}
    http = ctx.get("http") or {}
    return (http.get("method") or event.get("httpMethod") or "GET").upper()


def _read_json(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8", errors="replace")
    try:
        return json.loads(body)
    except Exception:
        return {}


_MISSING = object()

def _parse_ynab_exported_at(body: Dict[str, Any]):
    """Return 3-state value for YNAB export timestamp.
    - _MISSING if neither key is present
    - None if explicitly null/empty
    - ISO 8601 string if valid
    Raises ValueError if present but invalid.
    Accepts both ynabExportedAt (camelCase) and ynab_exported_at (snake_case).
    """
    if not isinstance(body, dict):
        return _MISSING

    if "ynabExportedAt" in body:
        val = body.get("ynabExportedAt")
    elif "ynab_exported_at" in body:
        val = body.get("ynab_exported_at")
    else:
        return _MISSING

    if val is None or val == "":
        return None

    if not isinstance(val, str):
        raise ValueError("ynabExportedAt must be an ISO 8601 string")

    try:
        # Accept Z suffix
        dt.datetime.fromisoformat(val.replace("Z", "+00:00"))
    except Exception:
        raise ValueError("Invalid ynabExportedAt: must be ISO 8601 timestamp")

    return val

def _claims(event: Dict[str, Any]) -> Dict[str, Any]:
    return (
        (event.get("requestContext") or {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    ) or {}


def _user_sub(event: Dict[str, Any]) -> str:
    c = _claims(event)
    return str(c.get("sub") or c.get("username") or "")



def _require_user(event: Dict[str, Any]) -> Dict[str, Any]:
    """Return JWT claims or raise 401 in callers."""
    return _claims(event)


def _require_env(origin: str) -> Optional[Dict[str, Any]]:
    if not RECEIPTS_TABLE or not UPLOADS_BUCKET:
        return _json(
            500,
            {"error": "server_misconfigured", "error_description": "Missing RECEIPTS_TABLE / UPLOADS_BUCKET"},
            origin,
        )
    return None


def _receipts_table():
    return dynamodb.Table(RECEIPTS_TABLE)


def _categories_table():
    return dynamodb.Table(USER_CATEGORIES_TABLE)


def _persist_inferred_fields(sub: str, receipt_id: str, db_item: Optional[Dict[str, Any]], inferred: Dict[str, Any], has_ocr: bool) -> Optional[Dict[str, Any]]:
    """
    Persist OCR-inferred fields into DynamoDB so reopening a DRAFT pre-fills the form.
    - Writes only fields that are currently missing in db_item.
    - Stores numeric fields as strings (consistent with _update_receipt).
    Returns the updated item (ALL_NEW) or None if no update was needed.
    """
    if not inferred:
        return None

    # Determine which fields are missing in DB
    missing_keys: List[str] = []
    for k in ["payee", "date", "total", "vat", "vatRate"]:
        cur = (db_item or {}).get(k)
        if cur is None or (isinstance(cur, str) and not cur.strip()):
            if inferred.get(k) is not None:
                missing_keys.append(k)

    # Nothing to persist
    cur_status = (db_item or {}).get("status")
    if not missing_keys and not (has_ocr and cur_status in (None, "NEW", "PROCESSED")):
        return None

    pk = f"USER#{sub}"
    sk = f"RECEIPT#{receipt_id}"
    now = _now_iso()

    expr = "SET updatedAt=:u"
    values: Dict[str, Any] = {":u": now}
    names: Dict[str, str] = {}

    def _set(attr: str, ph: str, value: Any):
        nonlocal expr
        names[f"#{attr}"] = attr
        values[ph] = value
        expr += f", #{attr}={ph}"

    # Persist inferred fields (numbers as strings)
    if "payee" in missing_keys:
        _set("payee", ":p", str(inferred.get("payee")).strip())
    if "date" in missing_keys:
        _set("date", ":d", str(inferred.get("date")).strip())
    if "total" in missing_keys:
        _set("total", ":t", str(inferred.get("total")))
    if "vat" in missing_keys:
        _set("vat", ":v", str(inferred.get("vat")))
    if "vatRate" in missing_keys:
        _set("vatRate", ":vr", str(inferred.get("vatRate")))

    # If OCR exists, ensure status is at least OCR_DONE (but don't overwrite CONFIRMED)
    if has_ocr and cur_status in (None, "NEW", "PROCESSED"):
        _set("status", ":s", "OCR_DONE")

    try:
        resp = _receipts_table().update_item(
            Key={"PK": pk, "SK": sk},
            UpdateExpression=expr,
            ExpressionAttributeNames=names if names else None,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(PK) AND attribute_exists(SK)",
            ReturnValues="ALL_NEW",
        )
        return resp.get("Attributes")
    except ClientError:
        return None



def _get_user_categories(user_sub: str) -> Dict[str, Any]:
    """Fetch user's categories list from DynamoDB.

    Schema:
      PK = USER#{sub}
      SK = CATEGORIES
      categories = [str]
    """
    if not USER_CATEGORIES_TABLE:
        return {"categories": DEFAULT_CATEGORIES, "source": "default"}

    resp = _categories_table().get_item(
        Key={"PK": f"USER#{user_sub}", "SK": "CATEGORIES"}
    )
    item = resp.get("Item")
    if not item or not isinstance(item.get("categories"), list) or not item.get("categories"):
        return {"categories": DEFAULT_CATEGORIES, "source": "default"}
    # Ensure strings & stable order (keep user order)
    cats = [str(x).strip() for x in item.get("categories") if str(x).strip()]
    cats = cats[:100]  # hard cap
    return {"categories": cats or DEFAULT_CATEGORIES, "source": "user"}


def _put_user_categories(user_sub: str, categories: Any) -> Dict[str, Any]:
    if not USER_CATEGORIES_TABLE:
        raise RuntimeError("Missing USER_CATEGORIES_TABLE")

    if not isinstance(categories, list):
        raise ValueError("categories must be a list")

    cleaned = []
    seen = set()
    for c in categories:
        s = str(c).strip()
        if not s:
            continue
        if len(s) > 40:
            s = s[:40]
        if s.lower() in seen:
            continue
        seen.add(s.lower())
        cleaned.append(s)
        if len(cleaned) >= 50:
            break

    # If user clears everything, fall back to defaults (but still store empty -> treat as default)
    _categories_table().put_item(
        Item={
            "PK": f"USER#{user_sub}",
            "SK": "CATEGORIES",
            "categories": cleaned,
            "updatedAt": int(time.time() * 1000),
        }
    )
    return {"categories": cleaned or DEFAULT_CATEGORIES, "source": "user" if cleaned else "default"}


# -------------------------
# Cognito token exchange
# -------------------------
def _cognito_token_exchange(code: str, redirect_uri: str, code_verifier: str) -> Dict[str, Any]:
    if not COGNITO_DOMAIN or not COGNITO_CLIENT_ID:
        raise RuntimeError("Missing COGNITO_DOMAIN / COGNITO_CLIENT_ID")

    token_url = f"https://{COGNITO_DOMAIN}/oauth2/token"
    form = {
        "grant_type": "authorization_code",
        "client_id": COGNITO_CLIENT_ID,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload)
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        try:
            j = json.loads(msg)
        except Exception:
            j = {"error": "invalid_grant", "error_description": msg}
        raise RuntimeError(f"Token exchange failed: {json.dumps(j)}")
    except Exception as e:
        raise RuntimeError(f"Token exchange failed: {str(e)}")


# -------------------------
# Receipt helpers (S3 artifacts)
# -------------------------
def _s3_key_original(sub: str, receipt_id: str) -> str:
    return f"original/{sub}/{receipt_id}"


def _s3_key_processed(sub: str, receipt_id: str) -> str:
    return f"processed/{sub}/{receipt_id}.jpg"


def _s3_key_ocr(sub: str, receipt_id: str) -> str:
    return f"ocr/{sub}/{receipt_id}.json"


def _s3_exists(key: str) -> bool:
    try:
        s3.head_object(Bucket=UPLOADS_BUCKET, Key=key)
        return True
    except ClientError:
        return False


def _s3_get_json(key: str) -> Optional[Dict[str, Any]]:
    try:
        obj = s3.get_object(Bucket=UPLOADS_BUCKET, Key=key)
        data = obj["Body"].read()
        return json.loads(data.decode("utf-8"))
    except ClientError:
        return None
    except Exception:
        return None


def _presigned_get(key: str, expires: int = 900) -> Optional[str]:
    try:
        return s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": UPLOADS_BUCKET, "Key": key},
            ExpiresIn=expires,
        )
    except ClientError:
        return None


def _money_to_number(s: str) -> Optional[float]:
    if not s:
        return None
    t = s.replace("€", "").replace("EUR", "").strip()
    if re.search(r"\d+,\d+", t) and not re.search(r"\d+\.\d+", t):
        t = t.replace(".", "").replace(",", ".")
    m = re.findall(r"[-+]?\d+(?:\.\d+)?", t)
    if not m:
        return None
    try:
        return float(m[0])
    except Exception:
        return None


def _extract_summary_fields(textract: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"fields": {}, "confidence": {}}
    docs = textract.get("ExpenseDocuments") or []
    if not docs:
        return out
    sf = docs[0].get("SummaryFields") or []

    def put(key: str, val: Any, conf: Optional[float]):
        if val is None or val == "":
            return
        out["fields"][key] = val
        if conf is not None:
            out["confidence"][key] = conf

    for f in sf:
        t = ((f.get("Type") or {}).get("Text") or "").upper()
        v = (f.get("ValueDetection") or {}).get("Text") or ""
        conf = (f.get("ValueDetection") or {}).get("Confidence")
        if conf is None:
            conf = (f.get("Type") or {}).get("Confidence")

        if t == "VENDOR_NAME":
            put("payee", v, conf)
        elif t == "INVOICE_RECEIPT_DATE":
            put("date_raw", v, conf)
        elif t == "TOTAL":
            put("total_raw", v, conf)
        elif t == "TAX":
            put("tax_raw", v, conf)
        elif t == "OTHER":
            label = ((f.get("LabelDetection") or {}).get("Text") or "").lower()
            if "tasso" in label and "%" in v:
                put("vat_rate_raw", v, conf)

    # Normalize numbers (best effort)
    if "total_raw" in out["fields"]:
        put("total", _money_to_number(out["fields"]["total_raw"]), out["confidence"].get("total_raw"))
    if "tax_raw" in out["fields"]:
        put("tax", _money_to_number(out["fields"]["tax_raw"]), out["confidence"].get("tax_raw"))

    return out


# -------------------------
# Receipts API
# -------------------------
def _create_receipt(event: Dict[str, Any], origin: str) -> Dict[str, Any]:
    missing = _require_env(origin)
    if missing:
        return missing

    sub = _user_sub(event)
    if not sub:
        return _json(401, {"message": "Unauthorized"}, origin)

    payload = _read_json(event)
    content_type = (payload.get("contentType") or payload.get("content_type") or "image/jpeg").strip() or "image/jpeg"

    receipt_id = str(uuid.uuid4())
    created_at = _now_iso()
    status = "NEW"

    key = _s3_key_original(sub, receipt_id)

    try:
        upload_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={"Bucket": UPLOADS_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=900,
        )
    except ClientError as e:
        return _json(500, {"error": "presign_failed", "message": str(e)}, origin)

    item = {
        "PK": f"USER#{sub}",
        "SK": f"RECEIPT#{receipt_id}",
        "GSI1PK": f"USER#{sub}#STATUS#{status}",
        "GSI1SK": created_at,
        "receiptId": receipt_id,
        "status": status,
        "createdAt": created_at,
        "contentType": content_type,
        "s3Bucket": UPLOADS_BUCKET,
        "s3Key": key,
    }

    try:
        _receipts_table().put_item(Item=item)
    except ClientError as e:
        return _json(500, {"error": "db_write_failed", "message": str(e)}, origin)

    return _json(
        201,
        {"receiptId": receipt_id, "uploadUrl": upload_url, "imagePath": f"s3://{UPLOADS_BUCKET}/{key}"},
        origin,
    )



def _parse_money(value: str) -> Optional[float]:
    if not value:
        return None
    # Keep digits, dot, comma, minus
    import re
    s = value.strip()
    s = s.replace("€", "").replace("$", "")
    s = s.replace(" ", "")
    # If comma used as decimal separator, convert to dot
    # If both comma and dot exist, assume dot is decimal and remove commas as thousands separators
    if "," in s and "." in s:
        s = s.replace(",", "")
    else:
        s = s.replace(",", ".")
    s = re.sub(r"[^0-9\.-]", "", s)
    if not s or s in {".", "-", "-.", ".-"}:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _infer_receipt_fields_from_summary(fields: Dict[str, Any]) -> Dict[str, Any]:
    """
    Inferisce i campi principali da:
    - output normalizzato di _extract_summary_fields() (keys: payee, date_raw, total_raw, tax_raw, total, tax, vat_rate_raw)
    - oppure (per compatibilità) da mappe Textract grezze con chiavi tipo VENDOR_NAME, INVOICE_RECEIPT_DATE, TOTAL, TAX...
    """
    def _pick(*keys: str) -> Optional[str]:
        for k in keys:
            v = fields.get(k)
            if v is None:
                continue
            if isinstance(v, (int, float)):
                return str(v)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    # Supporta sia schema "normalizzato" che "grezzo"
    payee = _pick("payee", "VENDOR_NAME", "SUPPLIER_NAME", "MERCHANT_NAME", "NAME")
    date_raw = _pick("date_raw", "INVOICE_RECEIPT_DATE", "TRANSACTION_DATE", "DATE")
    total_raw = _pick("total_raw", "TOTAL", "AMOUNT_PAID", "AMOUNT_DUE")
    vat_raw = _pick("tax_raw", "tax", "TAX", "VAT", "TOTAL_TAX")
    vat_rate_raw = _pick("vat_rate_raw")

    # Normalizza data a YYYY-MM-DD quando possibile
    date_norm = None
    if date_raw:
        s = date_raw.strip()
        from datetime import datetime
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%Y/%m/%d", "%d.%m.%Y"):
            try:
                date_norm = datetime.strptime(s[:10], fmt).date().isoformat()
                break
            except Exception:
                pass
        if date_norm is None:
            m = re.match(r"^(\d{1,2})[\-/](\d{1,2})[\-/](\d{2})$", s)
            if m:
                d, mo, y = m.groups()
                try:
                    date_norm = datetime.strptime(f"{d}-{mo}-20{y}", "%d-%m-%Y").date().isoformat()
                except Exception:
                    pass

    # Totale / IVA: se _extract_summary_fields ha già messo numeri, usa quelli
    total_val = fields.get("total")
    if total_val is None and total_raw:
        total_val = _parse_money(total_raw)

    vat_val = fields.get("tax")
    if vat_val is None and vat_raw:
        vat_val = _parse_money(vat_raw)

    # Aliquota IVA (best-effort)
    vat_rate = None
    if isinstance(vat_rate_raw, str) and "%" in vat_rate_raw:
        m = re.search(r"(\d{1,2}(?:[\.,]\d+)?)\s*%", vat_rate_raw)
        if m:
            try:
                vat_rate = float(m.group(1).replace(",", "."))
            except Exception:
                vat_rate = None
    if vat_rate is None and isinstance(total_val, (int, float)) and isinstance(vat_val, (int, float)):
        try:
            if total_val > 0 and vat_val > 0 and total_val > vat_val:
                base = total_val - vat_val
                if base > 0:
                    r = (vat_val / base) * 100.0
                    if 0.5 <= r <= 30:
                        vat_rate = round(r, 2)
        except Exception:
            pass

    out: Dict[str, Any] = {}
    if payee:
        out["payee"] = payee
    if date_norm:
        out["date"] = date_norm
    if total_val is not None:
        out["total"] = total_val
    if vat_val is not None:
        out["vat"] = vat_val
    if vat_rate is not None:
        out["vatRate"] = vat_rate
    return out

def _list_receipts(event: Dict[str, Any], origin: str) -> Dict[str, Any]:
    missing = _require_env(origin)
    if missing:
        return missing

    sub = _user_sub(event)
    if not sub:
        return _json(401, {"message": "Unauthorized"}, origin)

    try:
        resp = _receipts_table().query(
            KeyConditionExpression=Key("PK").eq(f"USER#{sub}") & Key("SK").begins_with("RECEIPT#"),
            Limit=50,
            ScanIndexForward=False,
        )
        items = resp.get("Items", [])
        out = []
        for it in items:
            # receiptId can be stored or derived from SK
            rid = it.get("receiptId") or (it.get("SK", "").split("#", 1)[1] if isinstance(it.get("SK"), str) and it.get("SK", "").startswith("RECEIPT#") else None)
            inferred: Dict[str, Any] = {}
            has_ocr = False
            if rid:
                key_ocr = _s3_key_ocr(sub, rid)
                has_ocr = _s3_exists(key_ocr)
                if has_ocr:
                    ocr_json = _s3_get_json(key_ocr)
                    if ocr_json:
                        summary = _extract_summary_fields(ocr_json)
                        inferred = _infer_receipt_fields_from_summary(summary.get("fields") or {})
                        # Persist missing fields opportunistically
                        updated = _persist_inferred_fields(sub, rid, it, inferred, has_ocr=True)
                        if updated:
                            it = updated
            out.append(
                {
                    "id": rid,
                    "receiptId": rid,  # per compatibilità frontend
                    "status": it.get("status"),
                    "createdAt": it.get("createdAt"),
                    "updatedAt": it.get("updatedAt"),
                    "payee": it.get("payee") or inferred.get("payee"),
                    "total": it.get("total") if it.get("total") is not None else inferred.get("total"),
                    "date": it.get("date") or inferred.get("date"),
                    "vat": it.get("vat") if it.get("vat") is not None else inferred.get("vat"),
                    "vatRate": it.get("vatRate") if it.get("vatRate") is not None else inferred.get("vatRate"),
                    "category": it.get("category"),
                    "ynabExportedAt": it.get("ynab_exported_at"),
                    "ynab_exported_at": it.get("ynab_exported_at"),
                    "notes": it.get("note"),
                    "s3Key": it.get("s3Key"),
                }
            )

        return _json(200, {"items": out}, origin)
    except ClientError as e:
        return _json(500, {"error": "db_query_failed", "message": str(e)}, origin)


def _get_receipt(event: Dict[str, Any], origin: str, receipt_id: str) -> Dict[str, Any]:
    missing = _require_env(origin)
    if missing:
        return missing

    sub = _user_sub(event)
    if not sub:
        return _json(401, {"message": "Unauthorized"}, origin)

    # 1. Fetch item from DynamoDB (contains user-edited fields)
    pk = f"USER#{sub}"
    sk = f"RECEIPT#{receipt_id}"
    try:
        db_resp = _receipts_table().get_item(Key={"PK": pk, "SK": sk})
        db_item = db_resp.get("Item")
    except ClientError:
        db_item = None

    key_original = _s3_key_original(sub, receipt_id)
    key_processed = _s3_key_processed(sub, receipt_id)
    key_ocr = _s3_key_ocr(sub, receipt_id)

    has_original = _s3_exists(key_original)
    has_processed = _s3_exists(key_processed)
    has_ocr = _s3_exists(key_ocr)

    if not has_original and not db_item:
        return _json(404, {"message": "Receipt not found"}, origin)

    # Status from DynamoDB takes precedence, fallback to inferred from S3
    status = "NEW"
    if db_item and db_item.get("status"):
        status = db_item["status"]
    elif has_processed:
        status = "PROCESSED"
    elif has_ocr:
        status = "OCR_DONE"

    ocr_json = _s3_get_json(key_ocr) if has_ocr else None
    summary = _extract_summary_fields(ocr_json) if ocr_json else {"fields": {}, "confidence": {}}

    inferred = _infer_receipt_fields_from_summary(summary.get("fields") or {})

    # Persist inferred fields immediately (fills drafts on reopen)
    if db_item and has_ocr and inferred:
        updated = _persist_inferred_fields(sub, receipt_id, db_item, inferred, has_ocr=True)
        if updated:
            db_item = updated

    processed_url = _presigned_get(key_processed, 900) if has_processed else None

    # 2. Build response
    response_data = {
        "receiptId": receipt_id,
        "status": (db_item.get("status") if db_item else None) or "NEW",
        "artifacts": {
            "originalKey": key_original,
            "processedKey": key_processed,
            "ocrKey": key_ocr if has_ocr else None,
            "processedUrl": processed_url,
            "ocrPresignedUrl": _presigned_get(key_ocr, 900) if has_ocr else None,
        },
        # Start with OCR-inferred values (best effort), then override with persisted values from DynamoDB.
        "payee": inferred.get("payee"),
        "date": inferred.get("date"),
        "total": inferred.get("total"),
        "vat": inferred.get("vat"),
        "vatRate": inferred.get("vatRate"),
        "note": None,
        "category": None,
        "createdAt": (db_item.get("createdAt") if db_item else None),
        "updatedAt": (db_item.get("updatedAt") if db_item else None),
    }

    if db_item:
        # Persisted values have priority (user-edited / confirmed).
        for k in ["payee", "date", "total", "vat", "vatRate", "note", "category", "createdAt", "updatedAt"]:
            v = db_item.get(k)
            if v is not None:
                response_data[k] = v
        response_data["note"] = db_item.get("note")
        response_data["category"] = db_item.get("category")
        response_data["createdAt"] = db_item.get("createdAt")
        response_data["updatedAt"] = db_item.get("updatedAt")
        response_data["confirmedAt"] = db_item.get("confirmedAt")
        response_data["ynabExportedAt"] = db_item.get("ynab_exported_at")
        response_data["ynab_exported_at"] = db_item.get("ynab_exported_at")

    return _json(200, response_data, origin)



# -------------------------
# Main handler
# -------------------------


def _normalize_date(date_str: str) -> str:
  """Accepts YYYY-MM-DD or DD-MM-YYYY and returns YYYY-MM-DD."""
  s = (date_str or "").strip()
  if not s:
    return s
  # already iso
  m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
  if m:
    return s
  m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", s)
  if m:
    dd, mm, yyyy = m.group(1), m.group(2), m.group(3)
    return f"{yyyy}-{mm}-{dd}"
  return s  # fallback as-is


def _update_receipt(event: Dict[str, Any], origin: str, receipt_id: str) -> Dict[str, Any]:
  user = _require_user(event)
  sub = user.get("sub")
  if not sub:
    return _json(401, {"error": "unauthorized"}, origin)

  body = _read_json(event)
  # ---- YNAB export tracking (optional)
  try:
    ynab_exported_at = _parse_ynab_exported_at(body)
  except ValueError as e:
    return _json(400, {"error": "validation_error", "message": str(e)}, origin)

  payee = (body.get("payee") or "").strip()
  date = _normalize_date(body.get("date") or "")
  total_v = (body.get("total") if "total" in body else body.get("amount"))
  if isinstance(total_v, (int, float)):
    total = str(total_v)
  else:
    total = (str(total_v) if total_v is not None else "").strip()
  vat_v = body.get("vat")
  if isinstance(vat_v, (int, float)):
    vat = str(vat_v)
  else:
    vat = (str(vat_v) if vat_v is not None else "").strip()
  vat_rate = (body.get("vatRate") or "").strip()
  note = (body.get("note") or body.get("notes") or "").strip()
  status = (body.get("status") or "").strip() or None

  # If confirming, enforce required fields
  if status == "CONFIRMED":
    missing = []
    if not payee: missing.append("payee")
    if not date: missing.append("date")
    if not total: missing.append("total")
    if missing:
      return _json(400, {"error": "validation_error", "missing": missing}, origin)

  now = _now_iso()
  pk = f"USER#{sub}"
  sk = f"RECEIPT#{receipt_id}"

  expr = "SET updatedAt=:u"
  values = {":u": now}
  names: Dict[str, str] = {}

  def set_attr(name: str, placeholder: str, value: Any):
    nonlocal expr
    if value is None:
      return
    names[f"#{name}"] = name
    values[placeholder] = value
    expr += f", #{name}={placeholder}"

  set_attr("payee", ":p", payee if payee else None)
  set_attr("date", ":d", date if date else None)
  set_attr("total", ":t", total if total else None)
  set_attr("vat", ":v", vat if vat else None)
  set_attr("vatRate", ":vr", vat_rate if vat_rate else None)
  set_attr("note", ":n", note if note else None)
  # Category: accept multiple key names (UI may send categoryId/category_id)
  category = (body.get("category") or body.get("categoryId") or body.get("category_id") or "").strip()
  set_attr("category", ":cat", category if category else None)


  if status:
    set_attr("status", ":s", status)
    if status == "CONFIRMED":
      set_attr("confirmedAt", ":c", now)
      # allow archive filtering by status via GSI
      set_attr("gsi1pk", ":gpk", pk)
      set_attr("gsi1sk", ":gsk", f"STATUS#{status}#{now}")


  # Persist YNAB exported timestamp in DynamoDB as snake_case attribute: ynab_exported_at
  # - if field not present in payload: do nothing
  # - if null/empty: REMOVE attribute
  # - else: SET attribute to ISO string
  if ynab_exported_at is not _MISSING:
    if ynab_exported_at is None:
      expr += " REMOVE ynab_exported_at"
    else:
      names["#yea"] = "ynab_exported_at"
      values[":yea"] = ynab_exported_at
      expr += ", #yea=:yea"
  table = _receipts_table()
  try:
    resp = table.update_item(
      Key={"PK": pk, "SK": sk},
      UpdateExpression=expr,
      ExpressionAttributeValues=values,
      ExpressionAttributeNames=names if names else None,
      ConditionExpression="attribute_exists(PK) AND attribute_exists(SK)",
      ReturnValues="ALL_NEW",
    )
  except ClientError as e:
    if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
      return _json(404, {"error": "not_found"}, origin)
    raise

  item = resp.get("Attributes") or {}
  return _json(200, {"receiptId": receipt_id, "item": item}, origin)

def _delete_receipt(event: Dict[str, Any], origin: str, receipt_id: str) -> Dict[str, Any]:
    """Delete a receipt ONLY if it's not confirmed.
    Also deletes related S3 objects (original/processed/ocr) best-effort.
    """
    missing = _require_env(origin)
    if missing:
        return missing

    sub = _user_sub(event)
    if not sub:
        return _json(401, {"message": "Unauthorized"}, origin)

    pk = f"USER#{sub}"
    sk = f"RECEIPT#{receipt_id}"

    # Delete from Dynamo with a condition: must NOT be confirmed.
    try:
        resp = _receipts_table().delete_item(
            Key={"PK": pk, "SK": sk},
            ConditionExpression="attribute_not_exists(confirmedAt) AND (attribute_not_exists(#st) OR #st <> :c)",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":c": "CONFIRMED"},
            ReturnValues="ALL_OLD",
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "ConditionalCheckFailedException":
            return _json(409, {"error": "cannot_delete_confirmed", "message": "Cannot delete a confirmed receipt"}, origin)
        if code == "ResourceNotFoundException":
            return _json(404, {"error": "not_found", "message": "Receipt not found"}, origin)
        # Could also be missing item (conditional fails): treat as 404-ish
        msg = str(e)
        return _json(500, {"error": "db_delete_failed", "message": msg}, origin)

    old = resp.get("Attributes") or {}
    if not old:
        # nothing deleted (item didn't exist)
        return _json(404, {"error": "not_found", "message": "Receipt not found"}, origin)

    # Best-effort cleanup in S3 (do not fail deletion if objects are missing)
    keys = set()

    # stored original key
    if old.get("s3Key"):
        keys.add(old["s3Key"])
    # computed defaults
    keys.add(_s3_key_original(sub, receipt_id))
    keys.add(_s3_key_processed(sub, receipt_id))
    keys.add(_s3_key_ocr(sub, receipt_id))

    # sometimes stored under these
    for k in ("processedKey", "ocrRawKey", "ocrKey"):
        if old.get(k):
            keys.add(old[k])

    # batch delete (up to 1000)
    try:
        objs = [{"Key": k} for k in keys if isinstance(k, str) and k.strip()]
        if objs:
            s3.delete_objects(Bucket=UPLOADS_BUCKET, Delete={"Objects": objs, "Quiet": True})
    except ClientError:
        # ignore cleanup errors
        pass

    return _json(200, {"ok": True, "deletedReceiptId": receipt_id}, origin)



def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    origin = _pick_allow_origin(event)
    try:
        path = _path(event)
        method = _method(event)

        # ---- Trial / entitlement guard (blocks only premium endpoints)
        from entitlements import entitlement_guard
        blocked = entitlement_guard(event, origin, _json)
        if blocked:
            return blocked

        if method == "OPTIONS":
            headers = _cors(origin)
            # HTTP API CORS may also add headers, but this keeps Lambda consistent and safe.
            return {"statusCode": 200, "headers": headers, "body": "{}"}

        if path == "/auth/exchange" and method == "POST":
            payload = _read_json(event)
            code = str(payload.get("code") or "")
            redirect_uri = str(payload.get("redirectUri") or payload.get("redirect_uri") or "")
            code_verifier = str(payload.get("codeVerifier") or payload.get("code_verifier") or "")

            if not code or not redirect_uri or not code_verifier:
                return _json(400, {"error": "invalid_request", "error_description": "Missing code / redirectUri / codeVerifier"}, origin)

            try:
                tokens = _cognito_token_exchange(code=code, redirect_uri=redirect_uri, code_verifier=code_verifier)
                return _json(200, tokens, origin)
            except RuntimeError as e:
                msg = str(e)
                if "Token exchange failed:" in msg:
                    try:
                        j = json.loads(msg.split("Token exchange failed:", 1)[1].strip())
                        return _json(400, j, origin)
                    except Exception:
                        return _json(400, {"error": "invalid_grant", "error_description": msg}, origin)
                return _json(500, {"error": "server_error", "error_description": msg}, origin)

        if path == "/receipts" and method == "POST":
            return _create_receipt(event, origin)

        if path == "/receipts" and method == "GET":
            return _list_receipts(event, origin)

        if path.startswith("/receipts/") and method == "GET":
            receipt_id = path.split("/", 2)[2]
            return _get_receipt(event, origin, receipt_id)

        if path.startswith("/receipts/") and method == "PUT":
            receipt_id = path.split("/", 2)[2]
            return _update_receipt(event, origin, receipt_id)

        if path.startswith("/receipts/") and method == "DELETE":
            receipt_id = path.split("/", 2)[2]
            return _delete_receipt(event, origin, receipt_id)


        if path == "/me" and method == "GET":
            return _get_me(event, origin)

        if path == "/categories" and method == "GET":
            sub = _user_sub(event)
            if not sub:
                return _json(401, {"message": "Unauthorized"}, origin)
            return _json(200, _get_user_categories(sub), origin)


        if path == "/categories" and method == "POST":
            sub = _user_sub(event)
            if not sub:
                return _json(401, {"message": "Unauthorized"}, origin)

            body = _parse_json_body(event)
            # Accept payloads:
            # 1) { "name": "Groceries" } (Lovable add-category modal)
            # 2) { "category": "Groceries" }
            # 3) { "value": "Groceries" }
            # 4) "Groceries"
            name = None
            if isinstance(body, dict):
                name = body.get("name") or body.get("category") or body.get("value")
            elif isinstance(body, str):
                name = body
            if not isinstance(name, str) or not name.strip():
                return _json(400, {"message": "Invalid payload. Expected {name: string}."}, origin)

            name = name.strip()
            # Load existing categories
            current = _get_user_categories(sub).get("categories") or []
            if not isinstance(current, list):
                current = []
            # Append if not present (case-insensitive)
            lowered = {str(x).strip().lower() for x in current if str(x).strip()}
            if name.lower() not in lowered:
                current.append(name)

            # Persist using same normalization rules as PUT handler (reusing logic by calling PUT-style block)
            # Normalize, de-dup, cap.
            cleaned = []
            seen = set()
            for x in current:
                s = str(x).strip()
                if not s:
                    continue
                if s.lower() in seen:
                    continue
                seen.add(s.lower())
                cleaned.append(s)
                if len(cleaned) >= 50:
                    break

            if USER_CATEGORIES_TABLE:
                _categories_table().put_item(
                    Item={
                        "PK": f"USER#{sub}",
                        "SK": "CATEGORIES",
                        "categories": cleaned,
                        "updatedAt": int(time.time() * 1000),
                    }
                )

            return _json(200, {"categories": cleaned or DEFAULT_CATEGORIES, "source": "user" if cleaned else "default"}, origin)

        if path == "/categories" and method == "PUT":
            sub = _user_sub(event)
            if not sub:
                return _json(401, {"message": "Unauthorized"}, origin)
            body = _parse_json_body(event)

            # Accept multiple payload shapes for backwards-compatibility:
            # 1) { "categories": ["A","B"] }   (preferred)
            # 2) ["A","B"]                     (legacy / UI convenience)
            # 3) { "items": ["A","B"] }        (tolerated)
            categories = None
            if isinstance(body, dict):
                categories = body.get("categories")
                if categories is None:
                    categories = body.get("items")
            elif isinstance(body, list):
                categories = body

            if not isinstance(categories, list) or not all(isinstance(x, str) for x in categories):
                return _json(400, {"message": "Invalid payload. Expected {categories: string[]} (or a JSON string[])."}, origin)
            # normalize: trim, de-dup, drop empty, cap length
            cleaned = []
            seen = set()
            for raw in categories:
                name = (raw or "").strip()
                if not name:
                    continue
                if name.lower() in seen:
                    continue
                seen.add(name.lower())
                cleaned.append(name[:60])
                if len(cleaned) >= 50:
                    break
            return _json(200, _put_user_categories(sub, cleaned), origin)

        if path == "/billing/checkout" and method == "POST":
            from billing import create_checkout_session
            return create_checkout_session(event, _json, origin)

        if path == "/billing/portal" and method == "POST":
            from billing import create_portal_session
            return create_portal_session(event, _json, origin)

        if path == "/webhooks/stripe" and method == "POST":
            from stripe_webhook import handle_stripe_webhook
            return handle_stripe_webhook(event, origin, _json)

        return _json(404, {"message": "Not Found"}, origin)

    except Exception as e:
        # Garantisce sempre una risposta JSON con header CORS (evita "CORS missing" in browser)
        return _json(500, {"error": "internal_error", "message": str(e)}, origin)

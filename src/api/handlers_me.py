# src/api/handlers_me.py
from typing import Any, Dict

from entitlements import (
    extract_user_claims,
    get_or_create_user,
    build_me_response,
    json_response,
)

ERROR_UNAUTHORIZED = {
    "error": "UNAUTHORIZED",
    "message": "Authentication required."
}


def handle_get_me(event: Dict[str, Any]) -> Dict[str, Any]:
    user_id, email = extract_user_claims(event)
    if not user_id:
        return json_response(401, ERROR_UNAUTHORIZED)

    user_item = get_or_create_user(user_id, email=email)
    payload = build_me_response(user_item)
    return json_response(200, payload)

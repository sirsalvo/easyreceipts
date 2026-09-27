"""
Offline test for the Stripe webhook (src/api/stripe_webhook.py).

The bug: create_checkout_session put metadata.userId on the Checkout
*Session*, not on subscription_data.metadata, so the Subscription object
Stripe sends back on customer.subscription.deleted has no metadata at all.
A cancellation could never be traced to a user, so it stayed "active"
forever - the account never fell back to the free tier.

The fix has two parts, both covered here: billing.py now also sets
subscription_data.metadata (test_billing.py), and stripe_webhook.py falls
back to matching stripeCustomerId in USERS_TABLE for every subscription that
already exists without that metadata (a real one is live in prod).

Stripe, DynamoDB and SSM are replaced with stubs: no credentials, no network,
no real signature verification.

Usage:
    python3 -m pip install boto3 stripe==14.3.0
    python3 test/test_stripe_webhook.py
"""
import base64
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(USERS_TABLE="test-users", AWS_DEFAULT_REGION="eu-central-1")

import stripe_webhook  # noqa: E402
import stripe  # noqa: E402

ORIGIN = "https://app.spendifyapp.com"


class FakeUsersTable:
    def __init__(self, rows=None):
        self.rows = {r["userId"]: dict(r) for r in (rows or [])}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        row = self.rows.setdefault(Key["userId"], {"userId": Key["userId"]})
        for name, attr in ExpressionAttributeNames.items():
            row[attr] = ExpressionAttributeValues[_placeholder_for(UpdateExpression, name)]

    def scan(self, FilterExpression, ProjectionExpression=None):
        expr = FilterExpression.get_expression()
        assert expr["operator"] == "=", "only equality filters are used in production code"
        attr_name, value = expr["values"][0].name, expr["values"][1]
        items = [{"userId": r["userId"]} for r in self.rows.values() if r.get(attr_name) == value]
        return {"Items": items}


def _placeholder_for(update_expression, name_placeholder):
    # UpdateExpression looks like "SET updatedAt=:u, #status=:st, ...";
    # find the value placeholder paired with this name placeholder.
    for part in update_expression.split(", "):
        lhs, _, rhs = part.partition("=")
        lhs = lhs.replace("SET ", "").strip()
        if lhs == name_placeholder:
            return rhs.strip()
    raise AssertionError(f"{name_placeholder} not found in {update_expression!r}")


users = None


def setup(rows=None):
    global users
    users = FakeUsersTable(rows)
    stripe_webhook._users_table = lambda: users
    stripe_webhook._stripe_init = lambda: None
    stripe_webhook._webhook_secret = lambda: "whsec_test"


def json_fn(status, body, origin):
    return status, body


def send(event_type, data_object, sig="valid"):
    body = json.dumps({"type": event_type, "data": {"object": data_object}})
    stripe.Webhook.construct_event = staticmethod(
        lambda payload, sig_header, secret: json.loads(payload) if sig_header == "valid" else (_ for _ in ()).throw(stripe.SignatureVerificationError("bad sig", sig_header))
    )
    event = {"headers": {"stripe-signature": sig}, "body": body}
    return stripe_webhook.handle_stripe_webhook(event, ORIGIN, json_fn)


def test_missing_signature_header_is_rejected():
    setup()
    status, body = stripe_webhook.handle_stripe_webhook({"headers": {}, "body": "{}"}, ORIGIN, json_fn)
    assert status == 400 and body["error"] == "BAD_REQUEST"


def test_bad_signature_is_rejected():
    setup()
    status, body = send("customer.subscription.deleted", {}, sig="wrong")
    assert status == 400 and body["error"] == "BAD_SIGNATURE"


def test_checkout_completed_activates_via_client_reference_id():
    setup(rows=[{"userId": "u1", "status": "trial"}])
    status, body = send("checkout.session.completed", {
        "client_reference_id": "u1", "customer": "cus_1", "subscription": "sub_1", "payment_status": "paid",
    })
    assert status == 200 and users.rows["u1"]["status"] == "active"
    assert users.rows["u1"]["stripeCustomerId"] == "cus_1"


def test_subscription_deleted_downgrades_using_metadata_when_present():
    setup(rows=[{"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"}])
    status, _ = send("customer.subscription.deleted", {
        "id": "sub_1", "customer": "cus_1", "metadata": {"userId": "u1"},
    })
    assert status == 200 and users.rows["u1"]["status"] == "expired"


def test_subscription_deleted_falls_back_to_stripe_customer_id_when_metadata_is_missing():
    # This is the actual bug: a subscription created before subscription_data.metadata
    # was added to checkout (every subscription that predates the fix). No metadata
    # at all on the object Stripe sends - the only link left is the customer id.
    setup(rows=[{"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"}])
    status, _ = send("customer.subscription.deleted", {
        "id": "sub_1", "customer": "cus_1", "metadata": {},
    })
    assert status == 200
    assert users.rows["u1"]["status"] == "expired", "a cancellation with no metadata must still downgrade the user"


def test_subscription_deleted_does_not_touch_other_users():
    setup(rows=[
        {"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"},
        {"userId": "u2", "status": "active", "stripeCustomerId": "cus_2"},
    ])
    send("customer.subscription.deleted", {"id": "sub_1", "customer": "cus_1", "metadata": {}})
    assert users.rows["u1"]["status"] == "expired"
    assert users.rows["u2"]["status"] == "active", "another user's subscription must be untouched"


def test_subscription_deleted_with_an_unresolvable_customer_does_not_crash_and_still_acks():
    setup(rows=[{"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"}])
    status, body = send("customer.subscription.deleted", {"id": "sub_1", "customer": "cus_unknown", "metadata": {}})
    # Stripe retries a non-200 forever; better to log and move on than to hang the queue.
    assert status == 200 and body == {"received": True}
    assert users.rows["u1"]["status"] == "active", "must not guess and downgrade the wrong (or no) user"


def test_invoice_payment_succeeded_also_uses_the_customer_id_fallback():
    setup(rows=[{"userId": "u1", "status": "expired", "stripeCustomerId": "cus_1"}])
    status, _ = send("invoice.payment_succeeded", {"subscription": "sub_1", "customer": "cus_1", "metadata": {}})
    assert status == 200 and users.rows["u1"]["status"] == "active"


def test_downgrade_is_idempotent():
    setup(rows=[{"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"}])
    for _ in range(2):
        status, _ = send("customer.subscription.deleted", {"id": "sub_1", "customer": "cus_1", "metadata": {"userId": "u1"}})
        assert status == 200
    assert users.rows["u1"]["status"] == "expired"


def test_unhandled_event_types_still_ack_so_stripe_stops_retrying():
    setup()
    status, body = send("customer.updated", {"id": "cus_1"})
    assert status == 200 and body == {"received": True}


def test_base64_encoded_body_is_decoded_first():
    setup(rows=[{"userId": "u1", "status": "active", "stripeCustomerId": "cus_1"}])
    raw = json.dumps({"type": "customer.subscription.deleted", "data": {"object": {"id": "sub_1", "customer": "cus_1", "metadata": {}}}})
    stripe.Webhook.construct_event = staticmethod(lambda payload, sig_header, secret: json.loads(payload))
    event = {"headers": {"stripe-signature": "valid"}, "body": base64.b64encode(raw.encode()).decode(), "isBase64Encoded": True}
    status, _ = stripe_webhook.handle_stripe_webhook(event, ORIGIN, json_fn)
    assert status == 200 and users.rows["u1"]["status"] == "expired"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok    {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)

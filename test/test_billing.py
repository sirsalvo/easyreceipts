"""
Offline test for the Stripe checkout / portal error paths (src/api/billing.py).

create_checkout_session had `except Exception:` followed by
`print(..., repr(e))` with `e` never bound. Any Stripe failure therefore raised
a NameError inside the handler: the customer got a generic 500 instead of the
CHECKOUT_FAILED message, and nothing useful was logged. These tests pin the
error paths and the parameters sent to Stripe.

Stripe, DynamoDB and SSM are replaced with stubs: no credentials, no network.

Usage:
    python3 -m pip install boto3 stripe==14.3.0
    python3 test/test_billing.py
"""
import contextlib
import io
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(
    APP_BASE_URL="https://app.spendifyapp.com",
    USERS_TABLE="test-users",
    AWS_DEFAULT_REGION="eu-central-1",
)

import billing  # noqa: E402
import stripe  # noqa: E402

ORIGIN = "https://app.spendifyapp.com"
USER = {"sub": "user-1", "email": "a@example.com"}
sent = []


def json_fn(status, body, origin):
    return status, body


def event(claims=USER):
    return {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}}


def setup(user=None, checkout=None, portal=None):
    sent.clear()
    billing._stripe_price_id = lambda: "price_123"
    billing._stripe_init = lambda: None
    billing._get_user = lambda user_id: user if user is not None else {}

    def create(**params):
        sent.append(params)
        if checkout is not None:
            return checkout(params)
        return {"url": "https://checkout.stripe.com/c/pay/abc"}

    stripe.checkout.Session.create = create
    stripe.billing_portal.Session.create = lambda **p: (portal(p) if portal else {"url": "https://billing.stripe.com/p/x"})


def raising(exc):
    def fn(_params):
        raise exc
    return fn


def run(fn, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = fn(*args)
    return result, out.getvalue()


def test_a_stripe_failure_returns_checkout_failed_and_is_logged():
    setup(checkout=raising(stripe.StripeError("card network unreachable")))
    (status, body), log = run(billing.create_checkout_session, event(), json_fn, ORIGIN)
    assert status == 500 and body["error"] == "CHECKOUT_FAILED", (status, body)
    assert "Stripe checkout error" in log and "card network unreachable" in log, f"nothing useful logged: {log!r}"


def test_any_unexpected_error_is_handled_the_same_way():
    setup(checkout=raising(RuntimeError("boom")))
    (status, body), log = run(billing.create_checkout_session, event(), json_fn, ORIGIN)
    assert status == 500 and body["error"] == "CHECKOUT_FAILED"
    assert "boom" in log


def test_checkout_sends_the_user_and_the_price():
    setup()
    (status, body), _ = run(billing.create_checkout_session, event(), json_fn, ORIGIN)
    assert status == 200 and body["url"].startswith("https://checkout.stripe.com/")
    p = sent[0]
    assert p["mode"] == "subscription" and p["line_items"] == [{"price": "price_123", "quantity": 1}]
    assert p["client_reference_id"] == "user-1" and p["metadata"] == {"userId": "user-1"}
    assert p["customer_email"] == "a@example.com" and "customer" not in p
    assert p["success_url"].endswith("/settings?billing=success")


def test_an_existing_customer_is_reused_instead_of_asking_for_an_email():
    setup(user={"stripeCustomerId": "cus_9"})
    run(billing.create_checkout_session, event(), json_fn, ORIGIN)
    p = sent[0]
    assert p["customer"] == "cus_9" and "customer_email" not in p


def test_checkout_requires_authentication():
    setup()
    (status, body), _ = run(billing.create_checkout_session, event(claims={}), json_fn, ORIGIN)
    assert status == 401 and not sent


def test_a_portal_failure_returns_portal_failed():
    setup(user={"stripeCustomerId": "cus_9"}, portal=raising(stripe.StripeError("down")))
    (status, body), _ = run(billing.create_portal_session, event(), json_fn, ORIGIN)
    assert status == 500 and body["error"] == "PORTAL_FAILED", (status, body)


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

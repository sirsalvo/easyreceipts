#!/usr/bin/env python3
"""
Delete everything Spendify stores about one user (GDPR erasure, and the
"delete my data" promise in the privacy policy / YNAB OAuth requirements).

Dry run by default: it only lists what it would delete. To delete, pass BOTH
--execute and --confirm <the user's sub>, so a typo in --email cannot delete
the wrong person.

    python3 scripts/delete_user_data.py --env prod --email someone@example.com
    python3 scripts/delete_user_data.py --env prod --sub <sub> --execute --confirm <sub>

Deletes, in this order (Cognito last, so a failed run can be repeated):
  S3 objects        original/<sub>/  processed/<sub>/  ocr/<sub>/
  receipts table    every item with PK = USER#<sub> (receipts, categories)
  categories table  PK = USER#<sub>
  users table       the row (trial/billing state and the encrypted YNAB tokens)
  Cognito           the user

Does NOT delete the Stripe customer: invoices may have to be kept for
accounting. The script prints the customer id so it can be handled in Stripe.
DynamoDB point-in-time backups keep earlier copies for up to 35 days.
"""
import argparse
import sys

import boto3

REGION = "eu-central-1"
PREFIXES = ("original", "processed", "ocr")


def stack_outputs(cf, env):
    stack = cf.describe_stacks(StackName=f"easyreceipts-{env}")["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def resolve_sub(cognito, pool_id, email, sub):
    """Returns (sub, cognito_username or None)."""
    if email:
        users = cognito.list_users(UserPoolId=pool_id, Filter=f'email = "{email}"')["Users"]
        if len(users) != 1:
            sys.exit(f"Expected exactly one Cognito user for {email}, found {len(users)}")
        attrs = {a["Name"]: a["Value"] for a in users[0]["Attributes"]}
        return attrs["sub"], users[0]["Username"]
    users = cognito.list_users(UserPoolId=pool_id, Filter=f'sub = "{sub}"')["Users"]
    return sub, (users[0]["Username"] if users else None)


def list_keys(s3, bucket, prefix):
    keys, token = [], None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        keys += [o["Key"] for o in resp.get("Contents", [])]
        if not resp.get("IsTruncated"):
            return keys
        token = resp["NextContinuationToken"]


def list_items(table, sub):
    items, start = [], None
    while True:
        kwargs = {
            "KeyConditionExpression": "PK = :pk",
            "ExpressionAttributeValues": {":pk": f"USER#{sub}"},
            "ProjectionExpression": "PK, SK",
        }
        if start:
            kwargs["ExclusiveStartKey"] = start
        resp = table.query(**kwargs)
        items += resp["Items"]
        start = resp.get("LastEvaluatedKey")
        if not start:
            return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", required=True, choices=["dev", "prod"])
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--email")
    who.add_argument("--sub")
    ap.add_argument("--execute", action="store_true", help="actually delete (default: dry run)")
    ap.add_argument("--confirm", help="the user's sub, required with --execute")
    args = ap.parse_args()

    session = boto3.Session(region_name=REGION)
    out = stack_outputs(session.client("cloudformation"), args.env)
    cognito = session.client("cognito-idp")
    s3 = session.client("s3")
    ddb = session.resource("dynamodb")

    sub, username = resolve_sub(cognito, out["UserPoolId"], args.email, args.sub)
    if args.execute and args.confirm != sub:
        sys.exit(f"Refusing: --confirm must equal the user's sub ({sub}).")

    bucket = out["UploadsBucketName"]
    receipts = ddb.Table(f"easyreceipts-{args.env}-receipts")
    categories = ddb.Table(out["UserCategoriesTableName"])
    users = ddb.Table(out["UsersTableName"])

    objects = [k for p in PREFIXES for k in list_keys(s3, bucket, f"{p}/{sub}/")]
    receipt_items = list_items(receipts, sub)
    category_items = list_items(categories, sub)
    user_row = users.get_item(Key={"userId": sub}).get("Item")

    mode = "DELETING" if args.execute else "DRY RUN (nothing deleted)"
    print(f"{mode}  env={args.env}  sub={sub}")
    print(f"  S3 objects          : {len(objects)}")
    print(f"  receipts table      : {len(receipt_items)}")
    print(f"  categories table    : {len(category_items)}")
    print(f"  users table row     : {'yes' if user_row else 'no'}"
          f"{'  (has YNAB connection)' if user_row and user_row.get('ynab') else ''}")
    print(f"  Cognito user        : {username or 'not found'}")
    if user_row and user_row.get("stripeCustomerId"):
        print(f"  Stripe customer     : {user_row['stripeCustomerId']}  <- NOT deleted here, handle in Stripe")

    if not args.execute:
        print("\nRe-run with --execute --confirm <sub> to delete.")
        return

    for i in range(0, len(objects), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in objects[i:i + 1000]]})
    for table, items in ((receipts, receipt_items), (categories, category_items)):
        with table.batch_writer() as batch:
            for it in items:
                batch.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})
    users.delete_item(Key={"userId": sub})
    if username:
        cognito.admin_delete_user(UserPoolId=out["UserPoolId"], Username=username)
    print("Done.")


if __name__ == "__main__":
    main()

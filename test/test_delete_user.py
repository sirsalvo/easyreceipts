"""
Offline test for scripts/delete_user_data.py (privacy-policy erasure promise).

The dry-run is verified against the dev stack by hand; the destructive path is
checked here with stubs so it never touches real data: it must remove every
store for that user only, paginate S3 past 1000 objects, and not run at all
without the matching --confirm.

Usage:
    python3 -m pip install boto3
    python3 test/test_delete_user.py
"""
import importlib.util
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("delete_user_data", os.path.join(REPO_ROOT, "scripts", "delete_user_data.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SUB = "sub-1"
OTHER = "sub-2"
log = []


class Cf:
    def describe_stacks(self, StackName):
        return {"Stacks": [{"Outputs": [
            {"OutputKey": "UserPoolId", "OutputValue": "pool"},
            {"OutputKey": "UploadsBucketName", "OutputValue": "bucket"},
            {"OutputKey": "UserCategoriesTableName", "OutputValue": "cats"},
            {"OutputKey": "UsersTableName", "OutputValue": "users"},
        ]}]}


class Cognito:
    def list_users(self, UserPoolId, Filter):
        if SUB in Filter or "a@example.com" in Filter:
            return {"Users": [{"Username": "cog-user", "Attributes": [{"Name": "sub", "Value": SUB}]}]}
        return {"Users": []}

    def admin_delete_user(self, UserPoolId, Username):
        log.append(("cognito", Username))


class S3:
    def __init__(self, n):
        self.objects = {f"original/{SUB}/{i}": 1 for i in range(n)}
        self.objects[f"original/{OTHER}/keep"] = 1
        self.delete_calls = []

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        start = int(ContinuationToken or 0)
        page = keys[start:start + 1000]
        more = start + 1000 < len(keys)
        resp = {"Contents": [{"Key": k} for k in page], "IsTruncated": more}
        if more:
            resp["NextContinuationToken"] = str(start + 1000)
        return resp

    def delete_objects(self, Bucket, Delete):
        self.delete_calls.append(len(Delete["Objects"]))
        for o in Delete["Objects"]:
            self.objects.pop(o["Key"], None)


class Table:
    def __init__(self, name, rows):
        self.name, self.rows = name, rows

    def query(self, KeyConditionExpression, ExpressionAttributeValues, ProjectionExpression, ExclusiveStartKey=None):
        pk = ExpressionAttributeValues[":pk"]
        return {"Items": [dict(r) for r in self.rows if r["PK"] == pk]}

    def get_item(self, Key):
        row = next((r for r in self.rows if r.get("userId") == Key["userId"]), None)
        return {"Item": row} if row else {}

    def delete_item(self, Key):
        log.append((self.name, Key))
        self.rows[:] = [r for r in self.rows if not all(r.get(k) == v for k, v in Key.items())]

    def batch_writer(self):
        table = self

        class W:
            def __enter__(s):
                return s

            def __exit__(s, *a):
                return False

            def delete_item(s, Key):
                table.delete_item(Key)

        return W()


def run(argv, n_objects=2500):
    log.clear()
    s3 = S3(n_objects)
    tables = {
        "easyreceipts-dev-receipts": Table("receipts", [
            {"PK": f"USER#{SUB}", "SK": "RECEIPT#1"}, {"PK": f"USER#{SUB}", "SK": "RECEIPT#2"},
            {"PK": f"USER#{OTHER}", "SK": "RECEIPT#9"}]),
        "cats": Table("cats", [{"PK": f"USER#{SUB}", "SK": "CATEGORIES"}]),
        "users": Table("users", [{"userId": SUB, "ynab": {"x": 1}, "stripeCustomerId": "cus_1"}, {"userId": OTHER}]),
    }

    class Ddb:
        def Table(self, name):
            return tables[name]

    class Session:
        def __init__(self, region_name):
            pass

        def client(self, name):
            return {"cloudformation": Cf(), "cognito-idp": Cognito(), "s3": s3}[name]

        def resource(self, name):
            return Ddb()

    mod.boto3.Session = Session
    sys.argv = ["delete_user_data.py", *argv]
    try:
        mod.main()
        code = 0
    except SystemExit as e:
        code = e.code
    return s3, tables, code


def test_dry_run_deletes_nothing():
    s3, tables, code = run(["--env", "dev", "--email", "a@example.com"])
    assert code == 0 and not log and not s3.delete_calls
    assert len(tables["users"].rows) == 2


def test_execute_needs_the_matching_confirm():
    for extra in ([], ["--confirm", "wrong"]):
        s3, tables, code = run(["--env", "dev", "--email", "a@example.com", "--execute", *extra])
        assert code not in (0, None) and not log and not s3.delete_calls


def test_execute_removes_only_that_user_everywhere():
    s3, tables, code = run(["--env", "dev", "--sub", SUB, "--execute", "--confirm", SUB])
    assert code == 0
    assert s3.delete_calls == [1000, 1000, 500], "S3 deletes must be batched at 1000 and cover all 2500"
    assert list(s3.objects) == [f"original/{OTHER}/keep"]
    assert [r["SK"] for r in tables["easyreceipts-dev-receipts"].rows if "SK" in r] == ["RECEIPT#9"]
    assert tables["cats"].rows == []
    assert [r["userId"] for r in tables["users"].rows] == [OTHER]
    assert log[-1] == ("cognito", "cog-user"), "Cognito must be deleted last"


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

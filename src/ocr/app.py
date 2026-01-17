import os, json, urllib.parse, time
import boto3

s3 = boto3.client("s3")
textract = boto3.client("textract")
dynamodb = boto3.resource("dynamodb")

RECEIPTS_TABLE = os.environ["RECEIPTS_TABLE"]
USAGE_TABLE = os.environ["USAGE_TABLE"]
UPLOADS_BUCKET = os.environ["UPLOADS_BUCKET"]

receipts = dynamodb.Table(RECEIPTS_TABLE)

def handler(event, context):
    for r in event.get("Records", []):
        b = r["s3"]["bucket"]["name"]
        k = urllib.parse.unquote_plus(r["s3"]["object"]["key"])
        if not k.startswith("processed/"):
            continue

        parts = k.split("/")
        if len(parts) < 3:
            continue
        user_id = parts[1]
        receipt_id = parts[2].split(".")[0]

        # Call Textract AnalyzeExpense
        resp = textract.analyze_expense(
            Document={"S3Object": {"Bucket": b, "Name": k}}
        )

        # Save raw for debugging
        raw_key = f"ocr/{user_id}/{receipt_id}.json"
        s3.put_object(
            Bucket=b,
            Key=raw_key,
            Body=json.dumps(resp).encode("utf-8"),
            ContentType="application/json"
        )

        ts = int(time.time() * 1000)
        receipts.update_item(
            Key={"PK": f"USER#{user_id}", "SK": f"RECEIPT#{receipt_id}"},
            UpdateExpression="SET ocrProvider=:p, ocrState=:s, ocrRawKey=:r, updatedAt=:u",
            ExpressionAttributeValues={
                ":p": "textract_expense",
                ":s": "READY",
                ":r": raw_key,
                ":u": ts,
            },
        )

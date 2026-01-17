import os, urllib.parse, time
import boto3

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

RECEIPTS_TABLE = os.environ["RECEIPTS_TABLE"]
UPLOADS_BUCKET = os.environ["UPLOADS_BUCKET"]
receipts = dynamodb.Table(RECEIPTS_TABLE)

def handler(event, context):
    # S3 event can contain multiple records
    for r in event.get("Records", []):
        b = r["s3"]["bucket"]["name"]
        k = urllib.parse.unquote_plus(r["s3"]["object"]["key"])

        if not k.startswith("original/"):
            continue

        # key: original/{userId}/{receiptId}.jpg
        parts = k.split("/")
        if len(parts) < 3:
            continue
        user_id = parts[1]
        receipt_id = parts[2].split(".")[0]

        processed_key = f"processed/{user_id}/{receipt_id}.jpg"

        # Copy as placeholder preprocess
        s3.copy_object(
            Bucket=b,
            CopySource={"Bucket": b, "Key": k},
            Key=processed_key,
            ContentType="image/jpeg",
            MetadataDirective="REPLACE"
        )

        # Update DynamoDB (best-effort)
        ts = int(time.time() * 1000)
        receipts.update_item(
            Key={"PK": f"USER#{user_id}", "SK": f"RECEIPT#{receipt_id}"},
            UpdateExpression="SET imageOriginalKey=:o, imageProcessedKey=:p, updatedAt=:u, ocrState=:s",
            ExpressionAttributeValues={
                ":o": k,
                ":p": processed_key,
                ":u": ts,
                ":s": "PENDING",
            },
        )

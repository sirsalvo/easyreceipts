sam validate --lint
sam build --use-container
sam deploy --stack-name easyreceipts-dev --region eu-central-1 --capabilities CAPABILITY_IAM --s3-bucket easyreceipts-sam-artifacts-408959241421-euc1 --no-resolve-s3 --parameter-overrides AppName=easyreceipts Env=dev UiDomainPrefix=easyreceipts-dev-ui-408959241421 TestsUserPoolClientId=17nmnav2nsjmlcdtfkmjokd9kt

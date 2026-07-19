import json
import os


def lambda_handler(event, context):
    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Hello, World! This is Python Lambda.",
                "env": os.environ,
            }
        ),
    }

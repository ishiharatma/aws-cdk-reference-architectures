"""
API handler Lambda for FIS chaos scenario B.

Provides a simple CRUD API backed by DynamoDB.
Routes:
  GET  /items         — list all items
  POST /items         — create an item {id, name}
  GET  /items/{id}    — get item by id
  DELETE /items/{id}  — delete item by id
"""
import json
import os
import uuid
import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ['TABLE_NAME']
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path = event.get('rawPath', '/')
    path_params = event.get('pathParameters') or {}

    try:
        if path == '/items' and method == 'GET':
            return list_items()
        elif path == '/items' and method == 'POST':
            body = json.loads(event.get('body') or '{}')
            return create_item(body)
        elif path.startswith('/items/') and method == 'GET':
            item_id = path_params.get('id') or path.split('/')[-1]
            return get_item(item_id)
        elif path.startswith('/items/') and method == 'DELETE':
            item_id = path_params.get('id') or path.split('/')[-1]
            return delete_item(item_id)
        else:
            return response(404, {'error': 'Not found'})
    except Exception as e:
        return response(500, {'error': str(e)})


def list_items():
    result = table.scan(Limit=100)
    return response(200, {'items': result.get('Items', [])})


def create_item(body):
    item_id = body.get('id') or str(uuid.uuid4())
    item = {
        'id': item_id,
        'name': body.get('name', 'unnamed'),
    }
    table.put_item(Item=item)
    return response(201, item)


def get_item(item_id):
    result = table.get_item(Key={'id': item_id})
    item = result.get('Item')
    if not item:
        return response(404, {'error': 'Item not found'})
    return response(200, item)


def delete_item(item_id):
    table.delete_item(Key={'id': item_id})
    return response(200, {'deleted': item_id})


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, default=str),
    }

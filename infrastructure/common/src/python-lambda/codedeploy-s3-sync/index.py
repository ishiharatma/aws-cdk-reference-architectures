import boto3
import json
import os
from logging import getLogger, INFO, DEBUG
import zipfile
import time
import traceback
import io

logger = getLogger()
logger.setLevel(INFO)

s3 = boto3.resource('s3')
s3client = boto3.client('s3')
cp = boto3.client('codepipeline')

def sync_s3(bucket, key, destination_bucket):
    logger.info('sync_s3 start')
    src_bucket = s3.Bucket(bucket)
    src_obj = src_bucket.Object(key)

    response = src_obj.get()
    body = response['Body'].read()

    zip_f = zipfile.ZipFile(io.BytesIO(body))
    lst = zip_f.namelist() 
    logger.info('zip file count: {}'.format(len(lst)))
    logger.debug('zip file list: {}'.format(lst))

    #dest_bucket = s3.Bucket(destination_bucket)
    #dest_keys = [object.key for object in dest_bucket.objects.all()]
    #logger.info('dest_keys count: {}'.format(len(dest_keys)))
    next_token = ''
    while True:
        if next_token == '':
            dest_list = s3client.list_objects_v2(Bucket=destination_bucket)
        else:
            dest_list = s3client.list_objects_v2(Bucket=destination_bucket, ContinuationToken=next_token)

        # dest_list = s3client.list_objects_v2(Bucket=destination_bucket)
        dest_keys = [object['Key'] for object in dest_list['Contents']] if 'Contents' in dest_list else []
        logger.info('dest_keys count: {}'.format(len(dest_keys)))
        logger.debug('dest_keys: {}'.format(dest_keys))

        for dest_obj in dest_keys:
            logger.debug('dest_obj: {}'.format(dest_obj))
            # オブジェクトのメタデータを取得
            headObj = s3client.head_object(Bucket=destination_bucket, Key=dest_obj)
            httpHeaders = headObj["ResponseMetadata"]["HTTPHeaders"]

            if (dest_obj not in lst):
                logger.info('delete: {}'.format(dest_obj))
                res = s3client.delete_object(Bucket=destination_bucket, Key=dest_obj)
                logger.debug('delete_object res: {}'.format(res))

        if 'NextContinuationToken' in response:
            next_token = response['NextContinuationToken']
        else:
            break

def put_job_success(job_id):
    logger.info('Putting job[{}] success'.format(job_id))
    cp.put_job_success_result(jobId=job_id)

def continue_job_later(job_id, invalidation_id):
    continuation_token = json.dumps({'InvalidationId':invalidation_id})
    logger.info('Putting job continuation')

    cp.put_job_success_result(
        jobId=job_id,
        continuationToken=continuation_token
    )

def put_job_failure(job_id, err):
    logger.error('Putting job[{}] failed'.format(job_id))
    message = 'Function exception: ' + str(err)
    cp.put_job_failure_result(
        jobId=job_id,
        failureDetails={
            'type': 'JobFailed',
            'message': message
        }
    )

def sns_publish(sns_topic_arn, pipeline_name, job_id, job_status):
    logger.info('Publish to SNS topic')

    message = 'PipelineName: ' + pipeline_name + '\n'
    message += 'JobId: ' + job_id + '\n'
    message += 'Status: ' + job_status + '\n'

    res = sns.publish(
        TopicArn=sns_topic_arn,
        Message=message
    )

    messaeg_id = res['MessageId']
    logger.info('SNS Messaeg ID is {}'.format(messaeg_id))

def lambda_handler(event, context):
    job_id = ''
    try:
        logger.info('start')
        logger.info('event: {}'.format(event))

        logLevel = os.environ.get('LOG_LEVEL', 'INFO')
        logger.setLevel(logLevel)
        job_id = event['CodePipeline.job']['id']
        job_data = event['CodePipeline.job']['data']
        logger.info("job_id:[{}]".format(job_id))
        logger.debug("job_data:[{}]".format(job_data))

        user_parameters = json.loads(
            job_data['actionConfiguration']['configuration']['UserParameters']
        )
        inputArtifacts = job_data['inputArtifacts'][0]
        inputArtifactsName = inputArtifacts['name']
        inputArtifactsS3Location = inputArtifacts['location']['s3Location']
        inputArtifactsS3Bucket = inputArtifactsS3Location['bucketName']
        inputArtifactsObjectKey = inputArtifactsS3Location['objectKey']

        logger.debug("inputArtifacts:[{}]".format(inputArtifacts))
        logger.debug("inputArtifactsName:[{}]".format(inputArtifactsName))
        logger.debug("inputArtifactsS3Location:[{}]".format(inputArtifactsS3Location))
        logger.debug("inputArtifactsS3Bucket:[{}]".format(inputArtifactsS3Bucket))
        logger.debug("inputArtifactsObjectKey:[{}]".format(inputArtifactsObjectKey))

        # S3 Sync
        sync_s3(inputArtifactsS3Bucket, inputArtifactsObjectKey, user_parameters['DEST_BUCKET_NAME'])

        put_job_success(job_id)
        return {
            'statusCode': 200,
            'body': {
                'job_id': job_id
            }
        }
    except Exception as err:
        logger.error('Function exception: %s', err)
        traceback.print_exc()
        put_job_failure(job_id, err)
        return {
              'statusCode': 500,
              'body': json.dumps('failed![%s]' % (str(err)))
        }
    finally:
        logger.info('complete.')

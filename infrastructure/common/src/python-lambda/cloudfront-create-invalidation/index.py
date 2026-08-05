import os
import boto3
import json
import logging
import time
import traceback

logger = logging.getLogger()
logger.setLevel(logging.INFO)

cp = boto3.client('codepipeline')
cf = boto3.client('cloudfront')
sns = boto3.client('sns')

def create_invalidation(distribution_id):
    logger.info('Creating invalidation')
    res = cf.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
        'Paths': {
            'Quantity': 1,
            'Items': ['/*'],
        },
        'CallerReference': str(time.time())
        }
    )

    invalidation_id = res['Invalidation']['Id']
    logger.info('InvalidationId is {}'.format(invalidation_id))
    return invalidation_id

def monitor_invalidation_state(distribution_id, invalidation_id):
    res = cf.get_invalidation(
        DistributionId=distribution_id,
        Id=invalidation_id
    )

    return res['Invalidation']['Status']

def put_job_success(job_id):
    logger.info('Putting job success')
    cp.put_job_success_result(jobId=job_id)

def continue_job_later(job_id, invalidation_id):
    continuation_token = json.dumps({'InvalidationId':invalidation_id})
    logger.info('Putting job continuation')

    cp.put_job_success_result(
        jobId=job_id,
        continuationToken=continuation_token
    )

def put_job_failure(job_id, err):
    logger.error('Putting job failed')
    message = 'Function exception: ' + str(err)
    cp.put_job_failure_result(
        jobId=job_id,
        failureDetails={
            'type': 'JobFailed',
            'message': message
        }
    )

def sns_publish(sns_topic_arn, pipeline_name, job_id, job_status):
    try:
        logger.info('Publish to SNS topic')

        message = 'PipelineName: ' + pipeline_name + '\n'
        message += 'JobId: ' + job_id + '\n'
        message += 'Status: ' + job_status + '\n'
        if sns_topic_arn:
            res = sns.publish(
                TopicArn=sns_topic_arn,
                Message=message
            )

            messaeg_id = res['MessageId']
            logger.info('SNS Messaeg ID is {}'.format(messaeg_id))
    except Exception as err:
        logger.error('sns_publish Error: %s', err)

def lambda_handler(event, context):
    try:
        job_id = event['CodePipeline.job']['id']
        job_data = event['CodePipeline.job']['data']
        logLevel = os.environ.get('LOG_LEVEL', 'INFO')
        logger.setLevel(logLevel)

        user_parameters = json.loads(
            job_data['actionConfiguration']['configuration']['UserParameters']
        )

        pipeline_name = user_parameters.get('PIPELINE_NAME')
        distribution_id = user_parameters.get('DISTRIBUTION_ID')
        sns_topic_arn = user_parameters.get('TOPIC_ARN')

        if 'continuationToken' in job_data:
            # 再実行されたときの処理
            continuation_token = json.loads(job_data['continuationToken'])
            invalidation_id = continuation_token['InvalidationId']
            logger.info('InvalidationId is {}'.format(invalidation_id))
            status = monitor_invalidation_state(distribution_id, invalidation_id)
            logger.info('Invalidation status is {}'.format(status))
            if not status == 'Completed':
                continue_job_later(job_id, invalidation_id)
            else:
                sns_publish(sns_topic_arn, pipeline_name, job_id, job_status='success')
                put_job_success(job_id)
        else:
            # invalidation を作成して，lambdaを再実行
            invalidation_id = create_invalidation(distribution_id)
            continue_job_later(job_id, invalidation_id)
    except Exception as err:
        logger.error('Function exception: %s', err)
        traceback.print_exc()
        sns_publish(sns_topic_arn, pipeline_name, job_id, job_status='failed')
        put_job_failure(job_id, err)
    finally:
        logger.info('Function complete')
    return "Complete."
"""
Path change detection Lambda handler

Overview:
  1. Get the commit ID from the CodeCommit push event
  2. If SYSTEM_DIR_PATH is set, check that the directory exists using codecommit:GetFolder.
     If the directory does not exist, do not start the pipeline.
  3. Get the list of changed files using codecommit:GetDifferences
  4. Start the pipeline only if a file matches PATH_PREFIXES
  When a branch is newly created (no oldCommitId), skip the path difference check and start the pipeline.

Environment variables:
  PIPELINE_NAME       - Name of the CodePipeline pipeline to start
  PATH_PREFIXES       - Comma-separated list of path prefixes
  SYSTEM_DIR_PATH     - (Optional) Directory path to check for existence (e.g. file-transfer/systems/csms)
                        If set, the pipeline will not start unless the directory exists at the commit.
  CODECOMMIT_ROLE_ARN - (Optional) IAM role ARN for cross-account CodeCommit access.
                        Set this when CodeCommit is in a different account.
                        If set, this role is assumed to call GetDifferences/GetFolder.
"""

import boto3
import os
import logging

logger = logging.getLogger()

def _check_system_dir_exists(cc_client, repository_name, commit_id, folder_path):
    """Check whether the directory exists at the given commit.
    Returns True always if folder_path is not set.
    """
    if not folder_path:
        return True
    try:
        cc_client.get_folder(
            repositoryName=repository_name,
            commitSpecifier=commit_id,
            folderPath=folder_path,
        )
        return True
    except cc_client.exceptions.FolderDoesNotExistException:
        logger.info(f"System directory not found: {folder_path} (commit: {commit_id})")
        return False


def _get_codecommit_client():
    """Return a CodeCommit boto3 client.
    If CODECOMMIT_ROLE_ARN is set, assume that role and create
    a client for cross-account access.
    """
    role_arn = os.environ.get("CODECOMMIT_ROLE_ARN")
    if role_arn:
        sts = boto3.client("sts")
        assumed = sts.assume_role(RoleArn=role_arn, RoleSessionName="PathFilterLambda")
        creds = assumed["Credentials"]
        return boto3.client(
            "codecommit",
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
    return boto3.client("codecommit")


def handler(event, context):
    detail = event["detail"]
    commit_id = detail["commitId"]
    old_commit_id = detail.get("oldCommitId")
    repository_name = detail["repositoryName"]

    prefixes = os.environ["PATH_PREFIXES"].split(",")
    pipeline_name = os.environ["PIPELINE_NAME"]
    system_dir_path = os.environ.get("SYSTEM_DIR_PATH")

    cp = boto3.client("codepipeline")

    def start_pipeline():
        logger.debug(f"Starting pipeline '{pipeline_name}' for commit '{commit_id}' in repository '{repository_name}'.")
        cp.start_pipeline_execution(name=pipeline_name)

    cc = _get_codecommit_client()

    # If SYSTEM_DIR_PATH is set, check that the directory exists at the commit
    if not _check_system_dir_exists(cc, repository_name, commit_id, system_dir_path):
        logger.debug(f"System directory '{system_dir_path}' does not exist at commit '{commit_id}'. Skipping pipeline start.")
        return  # Directory does not exist -> do not start the pipeline

    # On new branch creation, skip the path difference check and start the pipeline
    if not old_commit_id:
        logger.debug("No old commit ID (new branch), skipping path difference check and starting pipeline.")
        start_pipeline()
        return

    found = False
    next_token = None

    while True:
        kwargs = {
            "repositoryName": repository_name,
            "afterCommitSpecifier": commit_id,
            "beforeCommitSpecifier": old_commit_id,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        response = cc.get_differences(**kwargs)

        for diff in response.get("differences", []):
            after_blob = diff.get("afterBlob") or {}
            before_blob = diff.get("beforeBlob") or {}
            path = after_blob.get("path") or before_blob.get("path") or ""
            matched_prefixes = [prefix for prefix in prefixes if path.startswith(prefix)]
            logger.debug(f"path: '{path}', prefixes: {prefixes}, matched: {matched_prefixes}")
            if matched_prefixes:
                found = True
                break

        next_token = response.get("nextToken")
        if not next_token or found:
            break

    if found:
        logger.debug("Path difference found, starting pipeline.")
        start_pipeline()
    else:
        logger.debug("No path difference found, skipping pipeline start.")

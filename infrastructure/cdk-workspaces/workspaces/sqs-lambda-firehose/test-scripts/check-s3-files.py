#!/usr/bin/env python3
"""
S3 File Existence Checker

This script checks if files exist in an S3 bucket.
Useful for verifying that Lambda processed messages and stored results in S3.

Usage:
    python check-s3-files.py --bucket <BUCKET> --prefix <PREFIX> [--profile <PROFILE>]

Examples:
    # Check files in a specific prefix
    python check-s3-files.py --bucket my-bucket --prefix data/2026/01/

    # Check with specific profile
    python check-s3-files.py --bucket my-bucket --prefix data/ --profile dev

    # Check specific file
    python check-s3-files.py --bucket my-bucket --key data/file.json

    # List all files and check count
    python check-s3-files.py --bucket my-bucket --prefix data/ --list
"""

import argparse
import sys
from datetime import datetime
from typing import List, Dict, Any, Optional

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
except ImportError:
    print("Error: boto3 is not installed. Please install it with: pip install boto3")
    sys.exit(1)


class S3FileChecker:
    """S3 file existence checker"""

    def __init__(self, bucket: str, profile: str = None, region: str = None):
        """
        Initialize S3 file checker

        Args:
            bucket: S3 bucket name
            profile: AWS profile name (optional)
            region: AWS region (optional)
        """
        self.bucket = bucket
        session_kwargs = {}
        if profile:
            session_kwargs["profile_name"] = profile
        if region:
            session_kwargs["region_name"] = region

        try:
            session = boto3.Session(**session_kwargs)
            self.s3 = session.client("s3")
            self.s3_resource = session.resource("s3")
            print(f"✓ Connected to S3 using profile: {profile or 'default'}")
        except NoCredentialsError:
            print("Error: No AWS credentials found. Please configure your credentials.")
            sys.exit(1)
        except Exception as e:
            print(f"Error: Failed to create S3 client: {e}")
            sys.exit(1)

    def check_bucket_exists(self) -> bool:
        """
        Check if bucket exists

        Returns:
            True if bucket exists, False otherwise
        """
        try:
            self.s3.head_bucket(Bucket=self.bucket)
            return True
        except ClientError as e:
            error_code = e.response["Error"]["Code"]
            if error_code == "404":
                print(f"✗ Bucket does not exist: {self.bucket}")
            elif error_code == "403":
                print(f"✗ Access denied to bucket: {self.bucket}")
            else:
                print(f"✗ Error checking bucket: {e}")
            return False

    def check_file_exists(self, key: str) -> bool:
        """
        Check if a specific file exists

        Args:
            key: S3 object key

        Returns:
            True if file exists, False otherwise
        """
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            error_code = e.response["Error"]["Code"]
            if error_code == "404":
                return False
            else:
                print(f"✗ Error checking file {key}: {e}")
                return False

    def list_files(
        self, prefix: str = "", max_keys: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        List files in bucket with given prefix

        Args:
            prefix: S3 prefix (folder path)
            max_keys: Maximum number of keys to return

        Returns:
            List of file information dictionaries
        """
        files = []
        try:
            paginator = self.s3.get_paginator("list_objects_v2")
            pages = paginator.paginate(
                Bucket=self.bucket,
                Prefix=prefix,
                PaginationConfig={"MaxItems": max_keys},
            )

            for page in pages:
                if "Contents" in page:
                    for obj in page["Contents"]:
                        files.append(
                            {
                                "key": obj["Key"],
                                "size": obj["Size"],
                                "last_modified": obj["LastModified"],
                                "etag": obj["ETag"].strip('"'),
                            }
                        )

        except ClientError as e:
            print(f"✗ Error listing files: {e}")

        return files

    def format_size(self, size: int) -> str:
        """
        Format file size in human-readable format

        Args:
            size: Size in bytes

        Returns:
            Formatted size string
        """
        for unit in ["B", "KB", "MB", "GB", "TB"]:
            if size < 1024.0:
                return f"{size:.2f} {unit}"
            size /= 1024.0
        return f"{size:.2f} PB"

    def print_file_info(self, file_info: Dict[str, Any]) -> None:
        """
        Print file information

        Args:
            file_info: File information dictionary
        """
        print(f"  Key:           {file_info['key']}")
        print(
            f"  Size:          {self.format_size(file_info['size'])} ({file_info['size']:,} bytes)"
        )
        print(f"  Last Modified: {file_info['last_modified']}")
        print(f"  ETag:          {file_info['etag']}")
        print()

    def check_files_with_pattern(
        self, prefix: str, pattern: str = None
    ) -> Dict[str, Any]:
        """
        Check files matching a pattern

        Args:
            prefix: S3 prefix
            pattern: Pattern to match (optional)

        Returns:
            Dictionary with check results
        """
        print(f"\nChecking files in s3://{self.bucket}/{prefix}")
        print("=" * 70)

        files = self.list_files(prefix)

        if pattern:
            files = [f for f in files if pattern in f["key"]]

        total_files = len(files)
        total_size = sum(f["size"] for f in files)

        return {"files": files, "total_files": total_files, "total_size": total_size}


def main():
    """Main function"""
    parser = argparse.ArgumentParser(
        description="Check S3 file existence",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument("--bucket", required=True, help="S3 bucket name")

    parser.add_argument("--prefix", default="", help="S3 prefix (folder path)")

    parser.add_argument("--key", help="Specific S3 object key to check")

    parser.add_argument("--pattern", help="Pattern to match in file names")

    parser.add_argument("--profile", help="AWS profile name to use")

    parser.add_argument("--region", help="AWS region")

    parser.add_argument(
        "--list", action="store_true", help="List all matching files with details"
    )

    parser.add_argument(
        "--max-keys",
        type=int,
        default=1000,
        help="Maximum number of files to list (default: 1000)",
    )

    args = parser.parse_args()

    # Create checker
    checker = S3FileChecker(
        bucket=args.bucket, profile=args.profile, region=args.region
    )

    # Check bucket exists
    if not checker.check_bucket_exists():
        sys.exit(1)

    print(f"✓ Bucket exists: {args.bucket}\n")

    # Check specific file
    if args.key:
        print(f"Checking file: s3://{args.bucket}/{args.key}")
        print("=" * 70)

        if checker.check_file_exists(args.key):
            print(f"✓ File exists: {args.key}")

            # Get file details
            try:
                response = checker.s3.head_object(Bucket=args.bucket, Key=args.key)
                file_info = {
                    "key": args.key,
                    "size": response["ContentLength"],
                    "last_modified": response["LastModified"],
                    "etag": response["ETag"].strip('"'),
                }
                print()
                checker.print_file_info(file_info)
            except Exception as e:
                print(f"Error getting file details: {e}")

        else:
            print(f"✗ File does not exist: {args.key}")
            sys.exit(1)

    # Check files with prefix
    else:
        results = checker.check_files_with_pattern(args.prefix, args.pattern)

        print(f"\nSummary:")
        print(f"  Total Files: {results['total_files']}")
        print(
            f"  Total Size:  {checker.format_size(results['total_size'])} ({results['total_size']:,} bytes)"
        )

        if results["total_files"] == 0:
            print(f"\n✗ No files found in s3://{args.bucket}/{args.prefix}")
            if args.pattern:
                print(f"   with pattern: {args.pattern}")
            sys.exit(1)
        else:
            print(f"\n✓ Found {results['total_files']} file(s)")

        # List files if requested
        if args.list:
            print("\nFiles:")
            print("-" * 70)
            for i, file_info in enumerate(results["files"], 1):
                print(f"{i}.")
                checker.print_file_info(file_info)

        # Show first few files if not listing all
        elif results["total_files"] > 0 and not args.list:
            print("\nFirst 5 files (use --list to see all):")
            print("-" * 70)
            for i, file_info in enumerate(results["files"][:5], 1):
                print(
                    f"{i}. {file_info['key']} ({checker.format_size(file_info['size'])})"
                )


if __name__ == "__main__":
    main()

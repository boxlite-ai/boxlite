"""Host-side S3 bootstrap, without a second image or guessed one-shot exit."""

from contextlib import closing

from .config import InfraConfig


def storage_client(config: InfraConfig):
    import boto3
    from botocore.config import Config

    return closing(boto3.client(
        "s3",
        endpoint_url=f"http://127.0.0.1:{config.minio_host_port}",
        aws_access_key_id=config.minio_user,
        aws_secret_access_key=config.minio_password,
        region_name="us-east-1",
        config=Config(
            signature_version="s3v4", s3={"addressing_style": "path"},
            connect_timeout=2, read_timeout=5,
            retries={"mode": "standard", "total_max_attempts": 2},
        ),
    ))


def ensure_bucket(config: InfraConfig) -> None:
    from botocore.exceptions import BotoCoreError, ClientError

    try:
        with storage_client(config) as client:
            try:
                client.head_bucket(Bucket="boxlite")
                return
            except ClientError as exc:
                if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
                    raise
            try:
                client.create_bucket(Bucket="boxlite")
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "BucketAlreadyOwnedByYou":
                    raise
            client.head_bucket(Bucket="boxlite")
    except (BotoCoreError, ClientError):
        # Remote messages and SDK exceptions can contain credentials or bodies.
        raise RuntimeError(
            f"S3 bucket boxlite at 127.0.0.1:{config.minio_host_port}: "
            "bootstrap failed; check storage health and credentials"
        ) from None

#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-boxlite-dev-ClusterCluster-vmauahcx}"
VPC_ID="${VPC_ID:-vpc-0f3bd1effd970d18d}"
SUBNET_IDS="${SUBNET_IDS:-subnet-07d2d928a654beafa,subnet-0c5678eb9c8c8cd54}"
VPC_CIDR="${VPC_CIDR:-10.0.0.0/16}"
SERVICE_NAME="${SERVICE_NAME:-boxlite-dev-clickhouse}"
TASK_FAMILY="${TASK_FAMILY:-boxlite-dev-clickhouse}"
CONTAINER_NAME="${CONTAINER_NAME:-clickhouse}"
IMAGE="${IMAGE:-clickhouse/clickhouse-server:25.5}"
CPU="${CPU:-512}"
MEMORY="${MEMORY:-1024}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-50}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-otel}"
CLICKHOUSE_WRITER_USER="${CLICKHOUSE_WRITER_USER:-boxlite_otel_writer}"
CLICKHOUSE_READER_USER="${CLICKHOUSE_READER_USER:-$CLICKHOUSE_WRITER_USER}"
LOG_GROUP="${LOG_GROUP:-/boxlite/dev/clickhouse}"
TASK_EXECUTION_ROLE_NAME="${TASK_EXECUTION_ROLE_NAME:-boxlite-dev-clickhouse-task-execution-role}"
EBS_INFRA_ROLE_NAME="${EBS_INFRA_ROLE_NAME:-boxlite-dev-clickhouse-ebs-infra-role}"
SECURITY_GROUP_NAME="${SECURITY_GROUP_NAME:-boxlite-dev-clickhouse-fargate-sg}"
TMP_DIR="${TMP_DIR:-/tmp/boxlite-dev-clickhouse-fargate-ebs}"

usage() {
  cat <<USAGE
Usage: $0 <plan|render|create|status|print-env|delete>

Dev-only ClickHouse fallback on ECS Fargate + service-managed EBS.

Environment overrides:
  REGION=$REGION
  CLUSTER=$CLUSTER
  VPC_ID=$VPC_ID
  SUBNET_IDS=$SUBNET_IDS
  VPC_CIDR=$VPC_CIDR
  SERVICE_NAME=$SERVICE_NAME
  CPU=$CPU
  MEMORY=$MEMORY
  VOLUME_SIZE_GB=$VOLUME_SIZE_GB

Required for create:
  CLICKHOUSE_WRITER_PASSWORD
USAGE
}

cmd="${1:-}"
case "$cmd" in
  plan|render|create|status|print-env|delete) ;;
  *) usage; exit 2 ;;
esac

require_aws() {
  aws sts get-caller-identity --output json >/dev/null
}

require_create_secrets() {
  if [ -z "${CLICKHOUSE_WRITER_PASSWORD:-}" ]; then
    echo "CLICKHOUSE_WRITER_PASSWORD is required" >&2
    exit 2
  fi
}

account_id() {
  aws sts get-caller-identity --query Account --output text
}

role_arn() {
  local name="$1"
  aws iam get-role --role-name "$name" --query 'Role.Arn' --output text 2>/dev/null || true
}

security_group_id() {
  aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SECURITY_GROUP_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || true
}

task_definition_arn() {
  aws ecs describe-task-definition \
    --region "$REGION" \
    --task-definition "$TASK_FAMILY" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text 2>/dev/null || true
}

service_status() {
  aws ecs describe-services \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --services "$SERVICE_NAME" \
    --query 'services[0].status' \
    --output text 2>/dev/null || true
}

ensure_tmp_dir() {
  mkdir -p "$TMP_DIR"
}

render_files() {
  ensure_tmp_dir
  local task_execution_role_arn="$1"
  local ebs_infra_role_arn="$2"
  local network_security_group_id="$3"

  cat >"$TMP_DIR/ecs-task-trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

  cat >"$TMP_DIR/ecs-infrastructure-trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

  cat >"$TMP_DIR/task-definition.json" <<JSON
{
  "family": "$TASK_FAMILY",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "$CPU",
  "memory": "$MEMORY",
  "executionRoleArn": "$task_execution_role_arn",
  "runtimePlatform": {
    "cpuArchitecture": "ARM64",
    "operatingSystemFamily": "LINUX"
  },
  "volumes": [
    {
      "name": "clickhouse-data",
      "configuredAtLaunch": true
    }
  ],
  "containerDefinitions": [
    {
      "name": "$CONTAINER_NAME",
      "image": "$IMAGE",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 8123,
          "protocol": "tcp",
          "name": "http"
        }
      ],
      "environment": [
        { "name": "CLICKHOUSE_DB", "value": "$CLICKHOUSE_DATABASE" },
        { "name": "CLICKHOUSE_USER", "value": "$CLICKHOUSE_WRITER_USER" },
        { "name": "CLICKHOUSE_PASSWORD", "value": "${CLICKHOUSE_WRITER_PASSWORD:-REDACTED}" }
      ],
      "mountPoints": [
        {
          "sourceVolume": "clickhouse-data",
          "containerPath": "/var/lib/clickhouse",
          "readOnly": false
        }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "clickhouse-client --user '$CLICKHOUSE_WRITER_USER' --password \"\$CLICKHOUSE_PASSWORD\" --query 'SELECT 1' >/dev/null"
        ],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "$LOG_GROUP",
          "awslogs-region": "$REGION",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
JSON

  cat >"$TMP_DIR/volume-configurations.json" <<JSON
[
  {
    "name": "clickhouse-data",
    "managedEBSVolume": {
      "roleArn": "$ebs_infra_role_arn",
      "encrypted": true,
      "volumeType": "gp3",
      "sizeInGiB": $VOLUME_SIZE_GB,
      "filesystemType": "xfs",
      "tagSpecifications": [
        {
          "resourceType": "volume",
          "propagateTags": "SERVICE",
          "tags": [
            { "key": "Name", "value": "$SERVICE_NAME-data" },
            { "key": "boxlite:env", "value": "dev" },
            { "key": "boxlite:component", "value": "clickhouse" }
          ]
        }
      ]
    }
  }
]
JSON

  cat >"$TMP_DIR/network-configuration.json" <<JSON
{
  "awsvpcConfiguration": {
    "subnets": [$(printf '"%s"' "${SUBNET_IDS//,/\",\"}")],
    "securityGroups": ["$network_security_group_id"],
    "assignPublicIp": "DISABLED"
  }
}
JSON
}

ensure_role() {
  local name="$1"
  local trust_file="$2"
  local policy_arn="$3"
  local arn
  arn="$(role_arn "$name")"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    arn="$(aws iam create-role \
      --role-name "$name" \
      --assume-role-policy-document "file://$trust_file" \
      --query 'Role.Arn' \
      --output text)"
  fi
  aws iam attach-role-policy --role-name "$name" --policy-arn "$policy_arn" >/dev/null
  echo "$arn"
}

ensure_log_group() {
  aws logs create-log-group --region "$REGION" --log-group-name "$LOG_GROUP" 2>/dev/null || true
  aws logs put-retention-policy --region "$REGION" --log-group-name "$LOG_GROUP" --retention-in-days 14
}

ensure_security_group() {
  local sg_id
  sg_id="$(security_group_id)"
  if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
    sg_id="$(aws ec2 create-security-group \
      --region "$REGION" \
      --group-name "$SECURITY_GROUP_NAME" \
      --description "BoxLite dev ClickHouse Fargate private access" \
      --vpc-id "$VPC_ID" \
      --query 'GroupId' \
      --output text)"
  fi
  aws ec2 authorize-security-group-ingress \
    --region "$REGION" \
    --group-id "$sg_id" \
    --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":8123,\"ToPort\":8123,\"IpRanges\":[{\"CidrIp\":\"$VPC_CIDR\",\"Description\":\"BoxLite dev VPC\"}]}]" 2>/dev/null || true
  echo "$sg_id"
}

print_config() {
  cat <<CONFIG
region=$REGION
cluster=$CLUSTER
vpc_id=$VPC_ID
subnet_ids=$SUBNET_IDS
vpc_cidr=$VPC_CIDR
service_name=$SERVICE_NAME
task_family=$TASK_FAMILY
image=$IMAGE
cpu=$CPU
memory=$MEMORY
volume_size_gb=$VOLUME_SIZE_GB
monthly_compute_estimate_usd=about_18
monthly_ebs_estimate_usd=about_5_for_50gb_gp3
data_durability=dev_disposable_service_managed_ebs_deleted_when_task_terminates
CONFIG
}

if [ "$cmd" = "plan" ]; then
  require_aws
  print_config
  aws sts get-caller-identity --output json
  aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SECURITY_GROUP_NAME-dryrun" \
    --description "dryrun" \
    --vpc-id "$VPC_ID" \
    --dry-run 2>&1 || true
  exit 0
fi

if [ "$cmd" = "render" ]; then
  ensure_tmp_dir
  render_files \
    "arn:aws:iam::000000000000:role/$TASK_EXECUTION_ROLE_NAME" \
    "arn:aws:iam::000000000000:role/$EBS_INFRA_ROLE_NAME" \
    "sg-placeholder"
  echo "$TMP_DIR/ecs-task-trust.json"
  echo "$TMP_DIR/ecs-infrastructure-trust.json"
  echo "$TMP_DIR/task-definition.json"
  echo "$TMP_DIR/volume-configurations.json"
  echo "$TMP_DIR/network-configuration.json"
  exit 0
fi

if [ "$cmd" = "create" ]; then
  require_aws
  require_create_secrets
  ensure_tmp_dir
  render_files \
    "arn:aws:iam::$(account_id):role/$TASK_EXECUTION_ROLE_NAME" \
    "arn:aws:iam::$(account_id):role/$EBS_INFRA_ROLE_NAME" \
    "sg-placeholder"
  task_role_arn="$(ensure_role "$TASK_EXECUTION_ROLE_NAME" "$TMP_DIR/ecs-task-trust.json" arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy)"
  infra_role_arn="$(ensure_role "$EBS_INFRA_ROLE_NAME" "$TMP_DIR/ecs-infrastructure-trust.json" arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForVolumes)"
  ensure_log_group
  sg_id="$(ensure_security_group)"
  render_files "$task_role_arn" "$infra_role_arn" "$sg_id"
  task_def_arn="$(aws ecs register-task-definition \
    --region "$REGION" \
    --cli-input-json "file://$TMP_DIR/task-definition.json" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"
  status="$(service_status)"
  if [ "$status" = "ACTIVE" ]; then
    aws ecs update-service \
      --region "$REGION" \
      --cluster "$CLUSTER" \
      --service "$SERVICE_NAME" \
      --task-definition "$task_def_arn" \
      --desired-count 1 \
      --volume-configurations "file://$TMP_DIR/volume-configurations.json" \
      --force-new-deployment >/dev/null
  else
    aws ecs create-service \
      --region "$REGION" \
      --cluster "$CLUSTER" \
      --service-name "$SERVICE_NAME" \
      --task-definition "$task_def_arn" \
      --desired-count 1 \
      --launch-type FARGATE \
      --platform-version 1.4.0 \
      --network-configuration "file://$TMP_DIR/network-configuration.json" \
      --volume-configurations "file://$TMP_DIR/volume-configurations.json" \
      --enable-ecs-managed-tags \
      --propagate-tags SERVICE \
      --tags key=boxlite:env,value=dev key=boxlite:component,value=clickhouse >/dev/null
  fi
  echo "service=$SERVICE_NAME"
  echo "task_definition=$task_def_arn"
  exit 0
fi

if [ "$cmd" = "status" ]; then
  require_aws
  aws ecs describe-services \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --services "$SERVICE_NAME" \
    --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,events:events[0:3].message}' \
    --output json
  task_arn="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE_NAME" --desired-status RUNNING --query 'taskArns[0]' --output text 2>/dev/null || true)"
  if [ -n "$task_arn" ] && [ "$task_arn" != "None" ]; then
    eni_id="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value | [0]' --output text)"
    private_ip="$(aws ec2 describe-network-interfaces --region "$REGION" --network-interface-ids "$eni_id" --query 'NetworkInterfaces[0].PrivateIpAddress' --output text)"
    echo "task_arn=$task_arn"
    echo "private_ip=$private_ip"
  fi
  exit 0
fi

if [ "$cmd" = "print-env" ]; then
  require_aws
  task_arn="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE_NAME" --desired-status RUNNING --query 'taskArns[0]' --output text 2>/dev/null || true)"
  if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
    echo "No running ClickHouse task found" >&2
    exit 1
  fi
  eni_id="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value | [0]' --output text)"
  private_ip="$(aws ec2 describe-network-interfaces --region "$REGION" --network-interface-ids "$eni_id" --query 'NetworkInterfaces[0].PrivateIpAddress' --output text)"
  cat <<ENV
CLICKHOUSE_EXPORTER_ENABLED=true
CLICKHOUSE_WRITER_ENDPOINT=http://$private_ip:8123
CLICKHOUSE_WRITER_DATABASE=$CLICKHOUSE_DATABASE
CLICKHOUSE_WRITER_USERNAME=$CLICKHOUSE_WRITER_USER
CLICKHOUSE_WRITER_PASSWORD=<set in remote secret env only>
CLICKHOUSE_READER_URL=http://$private_ip:8123
CLICKHOUSE_READER_DATABASE=$CLICKHOUSE_DATABASE
CLICKHOUSE_READER_USERNAME=$CLICKHOUSE_READER_USER
CLICKHOUSE_READER_PASSWORD=<same value as CLICKHOUSE_WRITER_PASSWORD for dev fallback>
CLICKHOUSE_CREATE_SCHEMA=true
CLICKHOUSE_COMPRESS=none
ENV
  exit 0
fi

if [ "$cmd" = "delete" ]; then
  require_aws
  if [ "$(service_status)" = "ACTIVE" ]; then
    aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE_NAME" --desired-count 0 >/dev/null
    aws ecs delete-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE_NAME" >/dev/null
    echo "deleted_service=$SERVICE_NAME"
  else
    echo "service_not_active=$SERVICE_NAME"
  fi
  exit 0
fi

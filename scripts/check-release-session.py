"""Fail closed before publishing to an active, bounded staging session."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess


def check_session(record, now=None):
    now = now or datetime.now(timezone.utc)
    if record.get("status") in ("OFF", "DESTROYED"):
        return False
    if record.get("status") != "READY":
        raise ValueError("Session is not READY for an application release")
    if record.get("account") != "058114477594" or record.get("region") != "us-east-1" or record.get("environment") != "staging":
        raise ValueError("Session does not match the deployment account/region/environment")
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", record.get("sessionId", "")):
        raise ValueError("Session ID is invalid")
    deadline = datetime.fromisoformat(record["deadline"].replace("Z", "+00:00"))
    cleanup = datetime.fromisoformat(record["cleanupStartAt"].replace("Z", "+00:00"))
    if deadline.tzinfo is None or cleanup.tzinfo is None:
        raise ValueError("Session timestamps must have a timezone")
    if not now + timedelta(minutes=30) < cleanup < deadline <= now + timedelta(hours=24):
        raise ValueError("Insufficient release/cleanup time or invalid deadline")
    if not re.fullmatch(r"arn:aws:scheduler:us-east-1:058114477594:schedule/techx-staging/cleanup-[a-f0-9]{40}", record.get("cleanupScheduleArn", "")):
        raise ValueError("Independent cleanup schedule is required")
    if not record.get("executionVersion") or record["executionVersion"] == "null":
        raise ValueError("Immutable execution version is required")
    return True


def verify_cleanup_schedule(record, schedule):
    expected_time = datetime.fromisoformat(record["cleanupStartAt"].replace("Z", "+00:00")).astimezone(timezone.utc)
    target = schedule.get("Target", {})
    if (schedule.get("Arn") != record["cleanupScheduleArn"] or schedule.get("State") != "ENABLED"
            or schedule.get("ScheduleExpressionTimezone") != "UTC"
            or schedule.get("ScheduleExpression") != f"at({expected_time.strftime('%Y-%m-%dT%H:%M:%S')})"
            or schedule.get("FlexibleTimeWindow") != dict(Mode="OFF")
            or schedule.get("ActionAfterCompletion") != "DELETE"
            or target.get("Arn") != "arn:aws:lambda:us-east-1:058114477594:function:techx-automation-cleanup-launcher"
            or target.get("RoleArn") != "arn:aws:iam::058114477594:role/techx-automation-scheduler"
            or json.loads(target.get("Input", "null")) != dict(sessionId=record["sessionId"], executionVersion=record["executionVersion"])):
        raise ValueError("Live cleanup schedule does not match the staging execution")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--verify-aws-schedule", action="store_true")
    args = parser.parse_args()
    record = json.loads(args.session.read_text(encoding="utf-8-sig"))
    ready = check_session(record)
    if ready and args.verify_aws_schedule:
        name = record["cleanupScheduleArn"].rsplit("/", 1)[1]
        response = subprocess.run(["aws", "scheduler", "get-schedule", "--name", name, "--group-name", "techx-staging",
                                   "--region", "us-east-1", "--output", "json"], check=True, capture_output=True, text=True)
        verify_cleanup_schedule(record, json.loads(response.stdout))
    output = f"active={str(ready).lower()}\n"
    if ready:
        output += f"session_id={record['sessionId']}\n"
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as stream:
            stream.write(output)
    else:
        print(output, end="")

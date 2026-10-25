import copy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("session", Path(__file__).with_name("check-release-session.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.record = dict(status="READY", account="058114477594", region="us-east-1", environment="staging",
                           sessionId="staging-session-123", deadline=(self.now + timedelta(hours=3)).isoformat(),
                           cleanupStartAt=(self.now + timedelta(hours=2)).isoformat(),
                           cleanupScheduleArn="arn:aws:scheduler:us-east-1:058114477594:schedule/techx-staging/cleanup-" + "a" * 40,
                           executionVersion="immutable-v1")

    def test_ready_and_off(self):
        self.assertTrue(module.check_session(self.record, self.now))
        self.assertFalse(module.check_session(dict(status="OFF"), self.now))
        self.assertFalse(module.check_session(dict(status="DESTROYED"), self.now))

    def test_rejects_untrusted_partial_or_expiring_records(self):
        for field, value in (("status", "DESTROYING"), ("account", "other"), ("region", "other"),
                             ("environment", "production"), ("sessionId", "bad\ninjection=true"),
                             ("cleanupScheduleArn", ""), ("deadline", self.now.isoformat()),
                             ("cleanupStartAt", (self.now + timedelta(minutes=5)).isoformat()),
                             ("deadline", "2026-10-23T12:00:00")):
            with self.subTest(field=field, value=value):
                bad = copy.deepcopy(self.record)
                bad[field] = value
                with self.assertRaises(ValueError): module.check_session(bad, self.now)

    def test_real_schedule_configuration_must_match(self):
        import json
        schedule = dict(Arn=self.record["cleanupScheduleArn"], State="ENABLED", ScheduleExpressionTimezone="UTC",
                        ScheduleExpression="at(" + datetime.fromisoformat(self.record["cleanupStartAt"]).strftime("%Y-%m-%dT%H:%M:%S") + ")",
                        FlexibleTimeWindow=dict(Mode="OFF"), ActionAfterCompletion="DELETE", Target=dict(
                            Arn="arn:aws:lambda:us-east-1:058114477594:function:techx-automation-cleanup-launcher",
                            RoleArn="arn:aws:iam::058114477594:role/techx-automation-scheduler",
                            Input=json.dumps(dict(sessionId=self.record["sessionId"], executionVersion=self.record["executionVersion"]))))
        module.verify_cleanup_schedule(self.record, schedule)
        for field, value in (("State", "DISABLED"), ("Arn", "wrong"), ("Target", {}), ("ScheduleExpression", "at(2099-01-01T00:00:00)")):
            wrong = copy.deepcopy(schedule)
            wrong[field] = value
            with self.assertRaises(ValueError): module.verify_cleanup_schedule(self.record, wrong)


if __name__ == "__main__":
    unittest.main()

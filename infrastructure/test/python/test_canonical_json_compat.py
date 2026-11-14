import hashlib
import json
import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path

FIXTURE = Path(__file__).parents[1] / "fixtures" / "canonical-json-v1-golden.json"
TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$"
)


def assert_unicode_scalars(value):
    if isinstance(value, str):
        value.encode("utf-8", "strict")
    elif isinstance(value, list):
        for item in value:
            assert_unicode_scalars(item)
    elif isinstance(value, dict):
        for item in value.values():
            assert_unicode_scalars(item)


def canonical_json(value):
    assert_unicode_scalars(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sqs_json(value):
    return canonical_json(value).replace("\ufffe", "\\ufffe").replace("\uffff", "\\uffff")


def normalize_timestamp(value):
    match = TIMESTAMP.fullmatch(value)
    if not match:
        raise ValueError("invalid timestamp")
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    if zone == "Z":
        offset = timezone.utc
    else:
        sign = 1 if zone[0] == "+" else -1
        offset = timezone(sign * timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6])))
    base = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), tzinfo=offset)
    micros = int((Decimal(f"0.{fraction or '0'}") * Decimal(1_000_000)).quantize(Decimal(1), ROUND_HALF_EVEN))
    normalized = base.astimezone(timezone.utc) + timedelta(microseconds=micros)
    return normalized.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class CompatibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_canonical_and_sqs_bytes(self):
        canonical = canonical_json(self.fixture["input"]).encode("utf-8")
        sqs = sqs_json(self.fixture["input"]).encode("utf-8")
        expected = self.fixture["expected"]
        self.assertEqual(canonical.hex(), expected["canonicalUtf8Hex"])
        self.assertEqual(hashlib.sha256(canonical).hexdigest(), expected["canonicalSha256"])
        self.assertEqual(sqs.hex(), expected["sqsUtf8Hex"])
        self.assertEqual(hashlib.sha256(sqs).hexdigest(), expected["sqsSha256"])
        self.assertEqual(json.loads(sqs), self.fixture["input"])

    def test_timestamp_rounding(self):
        for vector in self.fixture["timestamps"]:
            self.assertEqual(normalize_timestamp(vector["input"]), vector["expected"])


if __name__ == "__main__":
    if "--print-vector" in sys.argv:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        canonical = canonical_json(fixture["input"]).encode("utf-8")
        sqs = sqs_json(fixture["input"]).encode("utf-8")
        print(json.dumps({
            "canonicalUtf8Hex": canonical.hex(),
            "canonicalSha256": hashlib.sha256(canonical).hexdigest(),
            "sqsUtf8Hex": sqs.hex(),
            "sqsSha256": hashlib.sha256(sqs).hexdigest(),
        }, indent=2))
    else:
        unittest.main()
